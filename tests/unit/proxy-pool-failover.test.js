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

vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(),
}));

const {
  DIRECT_POOL_KEY,
  isProxyPoolCoolingDown,
  getProxyPoolCooldownUntil,
  noteProxyPoolFailure,
  noteProxyPoolSuccess,
  pickChainEntry,
  resetProxyPoolHealth,
} = await import("../../src/lib/network/connectionProxy.js");

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
