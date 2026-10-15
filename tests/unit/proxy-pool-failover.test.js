// Pool failover for rate-limited exits (fork: feat/proxy-pool-failover).
//
// The chat loop retries a request through the next chain entry when the
// upstream answers 429. What that loop relies on lives here:
//
// - pickChainEntry(): which entry to use for this request. Entries already
//   tried by the request are skipped first, then entries on cooldown. When all
//   remaining entries cool down, the earliest-recovering one is used anyway.
// - noteProxyPoolFailure()/noteProxyPoolSuccess(): the in-memory cooldown that
//   keeps a rate-limited exit (or the direct path) out of rotation without
//   parking it for good.
//
// Cooldown bounds come from this module: floor 30s (burst windows), cap 1h
// (daily-quota Retry-After values are hours long and would otherwise remove an
// entry for the rest of the day). 429 uses the shared exponential backoff from
// open-sse/config/errorConfig.js underneath.
import { beforeEach, describe, expect, it, vi } from "vitest";

const modelsMock = vi.hoisted(() => ({
  getProxyPoolById: vi.fn(),
  getProxyPools: vi.fn(async () => []),
}));

vi.mock("@/models", () => modelsMock);
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ providerStrategies: {} })),
}));

const {
  DIRECT_POOL_KEY,
  ALL_POOLS_KEY,
  isProxyPoolCoolingDown,
  getProxyPoolCooldownUntil,
  noteProxyPoolFailure,
  noteProxyPoolSuccess,
  pickChainEntry,
  resetProxyPoolHealth,
  buildPoolPlan,
  getOrderedActivePools,
} = await import("../../src/lib/network/connectionProxy.js");

const { getSettings } = await import("../../src/lib/localDb");

const pool = (id, name, failoverOrder, createdAt = "2026-01-01T00:00:00.000Z") => ({
  id,
  name,
  proxyUrl: `http://${id}.local:8899`,
  isActive: true,
  failoverOrder,
  createdAt,
});

const POOL_KEY = "pool-mobile";

const chain = () => [
  { key: DIRECT_POOL_KEY, poolId: null },
  { key: POOL_KEY, poolId: POOL_KEY },
];

const cooldownLeft = (key) => getProxyPoolCooldownUntil(key) - Date.now();

beforeEach(() => {
  resetProxyPoolHealth();
});

describe("pickChainEntry", () => {
  it("starts on the direct entry", () => {
    expect(pickChainEntry(chain(), new Set()).key).toBe(DIRECT_POOL_KEY);
  });

  it("moves to the pool once direct was attempted by this request", () => {
    const entry = pickChainEntry(chain(), new Set([DIRECT_POOL_KEY]));
    expect(entry.key).toBe(POOL_KEY);
  });

  it("returns null when the request already tried every entry", () => {
    expect(pickChainEntry(chain(), new Set([DIRECT_POOL_KEY, POOL_KEY]))).toBe(null);
  });

  it("skips an entry that is cooling down", () => {
    noteProxyPoolFailure(DIRECT_POOL_KEY, 429, "rate limit exceeded");
    expect(isProxyPoolCoolingDown(DIRECT_POOL_KEY)).toBe(true);
    expect(pickChainEntry(chain(), new Set()).key).toBe(POOL_KEY);
  });

  it("uses the earliest-recovering entry when all of them cool down", () => {
    noteProxyPoolFailure(DIRECT_POOL_KEY, 429, "rate limit exceeded", 10 * 60 * 1000);
    noteProxyPoolFailure(POOL_KEY, 429, "rate limit exceeded", 2 * 60 * 1000);
    expect(pickChainEntry(chain(), new Set()).key).toBe(POOL_KEY);
  });

  it("ignores a single-entry chain that was already attempted", () => {
    const single = [{ key: DIRECT_POOL_KEY, poolId: null }];
    expect(pickChainEntry(single, new Set([DIRECT_POOL_KEY]))).toBe(null);
  });
});

describe("noteProxyPoolFailure", () => {
  it("applies the 30s floor to a header-less 429", () => {
    const cooldown = noteProxyPoolFailure(DIRECT_POOL_KEY, 429, "rate limit exceeded");
    expect(cooldown).toBe(30 * 1000);
    expect(cooldownLeft(DIRECT_POOL_KEY)).toBeGreaterThan(29 * 1000);
  });

  it("honours a Retry-After inside the cap", () => {
    const cooldown = noteProxyPoolFailure(DIRECT_POOL_KEY, 429, "", 5 * 60 * 1000);
    expect(cooldown).toBe(5 * 60 * 1000);
  });

  it("caps a day-long Retry-After at one hour", () => {
    const cooldown = noteProxyPoolFailure(DIRECT_POOL_KEY, 429, "", 20 * 60 * 60 * 1000);
    expect(cooldown).toBe(60 * 60 * 1000);
    expect(cooldownLeft(DIRECT_POOL_KEY)).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("does not cool down an entry for a status that is not worth a retry", () => {
    const cooldown = noteProxyPoolFailure(DIRECT_POOL_KEY, 400, "bad request");
    expect(cooldown).toBe(0);
    expect(isProxyPoolCoolingDown(DIRECT_POOL_KEY)).toBe(false);
  });

  it("treats a transport failure as transient", () => {
    const cooldown = noteProxyPoolFailure(POOL_KEY, 0, "fetch failed");
    expect(cooldown).toBe(30 * 1000);
    expect(isProxyPoolCoolingDown(POOL_KEY)).toBe(true);
  });
});

describe("model-scoped cooldowns", () => {
  // Free-tier limits are handed out per IP *and* per model. A limited model
  // must not park an entry for its siblings, or the second model pays a
  // pointless 429 before failing over.
  it("keeps a limited model on cooldown without touching another model", () => {
    noteProxyPoolFailure(DIRECT_POOL_KEY, 429, "rate limit exceeded", 0, "model-a");

    expect(isProxyPoolCoolingDown(DIRECT_POOL_KEY, "model-a")).toBe(true);
    expect(isProxyPoolCoolingDown(DIRECT_POOL_KEY, "model-b")).toBe(false);

    expect(pickChainEntry(chain(), new Set(), "model-a").key).toBe(POOL_KEY);
    expect(pickChainEntry(chain(), new Set(), "model-b").key).toBe(DIRECT_POOL_KEY);
  });

  it("clears only the model that answered", () => {
    noteProxyPoolFailure(POOL_KEY, 429, "rate limit exceeded", 0, "model-a");
    noteProxyPoolFailure(POOL_KEY, 429, "rate limit exceeded", 0, "model-b");

    noteProxyPoolSuccess(POOL_KEY, "model-a");

    expect(isProxyPoolCoolingDown(POOL_KEY, "model-a")).toBe(false);
    expect(isProxyPoolCoolingDown(POOL_KEY, "model-b")).toBe(true);
  });

  it("treats an entry and its model as one key", () => {
    noteProxyPoolFailure(DIRECT_POOL_KEY, 429, "rate limit exceeded", 0, "model-a");
    // A different entry must stay usable for the same model.
    expect(isProxyPoolCoolingDown(POOL_KEY, "model-a")).toBe(false);
  });
});

describe("noteProxyPoolSuccess", () => {
  it("clears the cooldown of the entry that answered", () => {
    noteProxyPoolFailure(POOL_KEY, 429, "rate limit exceeded");
    noteProxyPoolSuccess(POOL_KEY);
    expect(isProxyPoolCoolingDown(POOL_KEY)).toBe(false);
  });

  it("clears the direct entry too", () => {
    noteProxyPoolFailure(DIRECT_POOL_KEY, 429, "rate limit exceeded");
    noteProxyPoolSuccess(DIRECT_POOL_KEY);
    expect(pickChainEntry(chain(), new Set()).key).toBe(DIRECT_POOL_KEY);
  });
});

describe("buildPoolPlan", () => {
  const settingsFor = (override, providerId = "plan-provider") => ({
    providerStrategies: { [providerId]: override },
  });

  beforeEach(() => {
    modelsMock.getProxyPools.mockResolvedValue([
      pool("pool-mobile", "Mobile (phone tether)", 2),
      pool("pool-local", "Local (host)", 1),
    ]);
  });

  it("puts direct first and walks every active pool in failover order", async () => {
    getSettings.mockResolvedValue(settingsFor({ rotateStrategy: "failover", proxyPoolId: ALL_POOLS_KEY }));
    const plan = await buildPoolPlan("plan-provider");
    expect(plan.chain.map((e) => e.key)).toEqual([DIRECT_POOL_KEY, "pool-local", "pool-mobile"]);
    expect(plan.chain[1].label).toBe("Local (host)");
  });

  it("keeps the single selected pool behaviour", async () => {
    getSettings.mockResolvedValue(settingsFor({ rotateStrategy: "failover", proxyPoolId: "pool-mobile" }));
    const plan = await buildPoolPlan("plan-provider");
    expect(plan.chain.map((e) => e.key)).toEqual([DIRECT_POOL_KEY, "pool-mobile"]);
  });

  it("ignores a selected pool that is not active", async () => {
    getSettings.mockResolvedValue(settingsFor({ rotateStrategy: "failover", proxyPoolId: "pool-missing" }));
    const plan = await buildPoolPlan("plan-provider");
    expect(plan.chain.map((e) => e.key)).toEqual([DIRECT_POOL_KEY]);
  });

  it("rotates the round-robin start pool once per plan (not per retry)", async () => {
    getSettings.mockResolvedValue(settingsFor({ rotateStrategy: "round-robin" }, "rr-provider"));
    const first = await buildPoolPlan("rr-provider");
    const second = await buildPoolPlan("rr-provider");
    expect(first.chain).toHaveLength(2);
    expect(second.chain).toHaveLength(2);
    expect(second.chain[0].key).not.toBe(first.chain[0].key);
    // The chain still contains every pool exactly once
    expect(new Set(second.chain.map((e) => e.key)).size).toBe(2);
  });

  it("returns an empty chain for strategy none without a pool", async () => {
    getSettings.mockResolvedValue(settingsFor({ rotateStrategy: "none" }));
    const plan = await buildPoolPlan("none-provider");
    expect(plan.chain).toEqual([]);
  });

  it("keeps a single pinned pool for strategy none", async () => {
    getSettings.mockResolvedValue(settingsFor({ rotateStrategy: "none", proxyPoolId: "pool-local" }, "none-pinned-provider"));
    const plan = await buildPoolPlan("none-pinned-provider");
    expect(plan.chain.map((e) => e.key)).toEqual(["pool-local"]);
  });

  it("orders active pools by failoverOrder then createdAt", async () => {
    modelsMock.getProxyPools.mockResolvedValue([
      pool("c", "C", 2, "2026-01-02T00:00:00.000Z"),
      pool("a", "A", undefined, "2026-01-03T00:00:00.000Z"),
      pool("b", "B", 1, "2026-01-01T00:00:00.000Z"),
      pool("d", "D", 1, "2026-01-04T00:00:00.000Z"),
    ]);
    const ordered = await getOrderedActivePools();
    expect(ordered.map((p) => p.id)).toEqual(["b", "d", "c", "a"]);
  });
});
