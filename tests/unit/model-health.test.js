// Unit tests for the model-health module (model-health phase): probe
// classification, canary confirmation, strike/hide semantics, orphan keep and
// the health-aware listing merge.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalStrikes = process.env.MODEL_HEALTH_STRIKES;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-health-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalStrikes === undefined) delete process.env.MODEL_HEALTH_STRIKES;
  else process.env.MODEL_HEALTH_STRIKES = originalStrikes;
});

function writeRawCatalog(catalog) {
  fs.writeFileSync(path.join(tempDir, "model-catalog-raw.json"), JSON.stringify(catalog), "utf8");
}

// One fetch stub for both the Zen live list and the probe self-calls.
function stubZen({ live = [], probes = {} } = {}) {
  const fetchMock = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("opencode.ai")) {
      return { ok: true, status: 200, json: async () => ({ data: live.map((id) => ({ id })) }), text: async () => "" };
    }
    if (u.includes("/v1/chat/completions")) {
      let model = "";
      try { model = String(JSON.parse(opts.body || "{}").model || "").replace(/^oc\//, ""); } catch {}
      const r = probes[model] || { status: 500, text: "unmapped probe" };
      return { ok: r.status === 200, status: r.status, text: async () => r.text || "" };
    }
    return { ok: false, status: 404, text: async () => "unknown url" };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function loadModules() {
  const health = await import("@/lib/modelCatalog/healthCheck.js");
  const repo = await import("@/lib/db/repos/modelHealthRepo.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  await getAdapter();
  const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
  await createApiKey("health-test", "test-machine");
  return { health, repo };
}

describe("classifyProbeResult", () => {
  it("only the explicit gone signature counts as gone; limits and outages never do", async () => {
    const { classifyProbeResult } = await import("@/lib/modelCatalog/healthCheck.js");
    expect(classifyProbeResult(200, "")).toBe("alive");
    expect(classifyProbeResult(400, '{"type":"error","error":{"message":"Upstream request failed: Model is unavailable."}}')).toBe("candidate-gone");
    expect(classifyProbeResult(404, "model not found")).toBe("candidate-gone");
    expect(classifyProbeResult(404, "unknown model")).toBe("candidate-gone");
    expect(classifyProbeResult(429, "rate limited")).toBe("rate_limited");
    expect(classifyProbeResult(503, "bad gateway")).toBe("error");
    expect(classifyProbeResult(0, "fetch failed")).toBe("error");
    expect(classifyProbeResult(400, "max_tokens must be >= 1")).toBe("unknown");
  });
});

describe("runHealthCheck", () => {
  it("marks a targeted model alive", async () => {
    stubZen({ live: ["space-bunny-free"], probes: { "step-5-preview-free": { status: 200, text: "pong" } } });
    const { health, repo } = await loadModules();

    const out = await health.runHealthCheck({ only: ["step-5-preview-free"] });
    expect(out.probed).toBe(1);
    expect(out.results[0]).toMatchObject({ model: "step-5-preview-free", outcome: "alive", strikes: 0, hidden: false });

    const row = await repo.getModelHealth("step-5-preview-free");
    expect(row.lastStatus).toBe("alive");
    expect(row.hidden).toBe(false);
    expect(row.lastAliveAt).toBeTruthy();
  });

  it("counts gone strikes only while the canary is healthy, hides at the threshold", async () => {
    process.env.MODEL_HEALTH_STRIKES = "2";
    stubZen({
      live: ["big-pickle", "space-bunny-free"],
      probes: {
        "step-5-preview-free": { status: 400, text: "Upstream request failed: Model is unavailable." },
        "big-pickle": { status: 200, text: "pong" },
      },
    });
    const { health, repo } = await loadModules();

    await health.runHealthCheck({ only: ["step-5-preview-free"] });
    let row = await repo.getModelHealth("step-5-preview-free");
    expect(row.strikes).toBe(1);
    expect(row.hidden).toBe(false);
    expect(row.lastStatus).toBe("gone");

    await health.runHealthCheck({ only: ["step-5-preview-free"] });
    row = await repo.getModelHealth("step-5-preview-free");
    expect(row.strikes).toBe(2);
    expect(row.hidden).toBe(true);
  });

  it("does not count a strike while the canary also fails (platform outage)", async () => {
    stubZen({
      live: ["big-pickle"],
      probes: {
        "step-5-preview-free": { status: 400, text: "Model is unavailable." },
        "big-pickle": { status: 503, text: "service unavailable" },
      },
    });
    const { health, repo } = await loadModules();

    const out = await health.runHealthCheck({ only: ["step-5-preview-free"] });
    expect(out.results[0].outcome).toBe("unverified");
    const row = await repo.getModelHealth("step-5-preview-free");
    expect(row.strikes ?? 0).toBe(0);
    expect(row.hidden ?? false).toBe(false);
  });

  it("never strikes on 429 and records the observation", async () => {
    stubZen({ live: ["big-pickle"], probes: { "step-5-preview-free": { status: 429, text: "rate limited" } } });
    const { health, repo } = await loadModules();

    await health.runHealthCheck({ only: ["step-5-preview-free"] });
    const row = await repo.getModelHealth("step-5-preview-free");
    expect(row.strikes ?? 0).toBe(0);
    expect(row.lastStatus).toBe("rate_limited");
  });

  it("a later 200 unhides and clears the strikes", async () => {    process.env.MODEL_HEALTH_STRIKES = "1";
    stubZen({
      live: ["big-pickle"],
      probes: {
        "step-5-preview-free": { status: 400, text: "Model is unavailable." },
        "big-pickle": { status: 200, text: "pong" },
      },
    });
    const { health, repo } = await loadModules();

    await health.runHealthCheck({ only: ["step-5-preview-free"] });
    expect((await repo.getModelHealth("step-5-preview-free")).hidden).toBe(true);

    stubZen({ live: ["big-pickle"], probes: { "step-5-preview-free": { status: 200, text: "pong" } } });
    await health.runHealthCheck({ only: ["step-5-preview-free"] });
    const row = await repo.getModelHealth("step-5-preview-free");
    expect(row.hidden).toBe(false);
    expect(row.strikes).toBe(0);
    expect(row.lastStatus).toBe("alive");
  });

  it("hidden stays sticky when the threshold changes", async () => {
    process.env.MODEL_HEALTH_STRIKES = "1";
    stubZen({
      live: ["big-pickle"],
      probes: {
        "step-5-preview-free": { status: 400, text: "Model is unavailable." },
        "big-pickle": { status: 200, text: "pong" },
      },
    });
    const { health, repo } = await loadModules();

    await health.runHealthCheck({ only: ["step-5-preview-free"] });
    expect((await repo.getModelHealth("step-5-preview-free")).hidden).toBe(true);

    // Raising the threshold must not unhide a confirmed-dead model.
    process.env.MODEL_HEALTH_STRIKES = "10";
    await health.runHealthCheck({ only: ["step-5-preview-free"] });
    expect((await repo.getModelHealth("step-5-preview-free")).hidden).toBe(true);
  });

  it("prunes rows for ids that are no longer candidates (custom model deleted)", async () => {
    stubZen({ live: ["big-pickle"] });
    const { health, repo } = await loadModules();

    await repo.upsertModelHealth("mimo-v2-pro-free", { hidden: true, strikes: 3, lastStatus: "gone" });
    const out = await health.runHealthCheck();
    expect(out.reason).not.toBe("no-api-key");
    expect(await repo.getModelHealth("mimo-v2-pro-free")).toBe(null);
  });
});

describe("collectProbeTargets", () => {
  it("probes listed ids outside the live list, including past-alive orphans; live ids are trusted", async () => {
    writeRawCatalog({ opencode: { "step-5-preview-free": { c: 1000000, o: 65536 } } });
    stubZen({ live: ["space-bunny-free"] });
    const { health, repo } = await loadModules();

    const db = await import("@/lib/db/index.js");
    await db.addCustomModel({ providerAlias: "oc", id: "space-bunny-free" });
    await db.addCustomModel({ providerAlias: "oc", id: "step-5-preview-free" });
    await db.addCustomModel({ providerAlias: "oc", id: "orphan-free" });
    await repo.upsertModelHealth("orphan-free", { lastStatus: "alive", strikes: 0, hidden: false });

    const targets = await health.collectProbeTargets();
    expect(targets).toContain("step-5-preview-free");
    expect(targets).toContain("orphan-free");
    expect(targets).not.toContain("space-bunny-free");
  });
});

describe("getModelHealthFilter / mergeListedIds", () => {
  it("filter view: hidden ids drop, alive ids become extras", async () => {
    const { repo } = await loadModules();
    await repo.upsertModelHealth("gone-free", { hidden: true, strikes: 10, lastStatus: "gone" });
    await repo.upsertModelHealth("step-5-preview-free", { hidden: false, lastStatus: "alive" });

    const { getModelHealthFilter } = await import("@/lib/modelCatalog/healthCheck.js");
    const filter = await getModelHealthFilter("opencode");
    expect([...filter.hidden]).toEqual(["gone-free"]);
    expect(filter.aliveExtras).toEqual(["step-5-preview-free"]);
  });

  it("merge keeps alive candidates, adds live-only and health-alive ids, drops hidden", async () => {
    const { mergeListedIds } = await import("@/lib/modelCatalog/healthCheck.js");
    const reality = { live: ["d"], alive: new Set(["a", "d"]) };
    const health = { hidden: new Set(["b"]), aliveExtras: ["c"] };
    expect(mergeListedIds({ mergedIds: ["a", "b"], reality, health })).toEqual(["a", "d", "c"]);
  });

  it("without catalogue information only hidden ids are dropped", async () => {
    const { mergeListedIds } = await import("@/lib/modelCatalog/healthCheck.js");
    const health = { hidden: new Set(["b"]), aliveExtras: [] };
    expect(mergeListedIds({ mergedIds: ["a", "b"], reality: null, health })).toEqual(["a"]);
  });
});

describe("probe rows stay out of the Usage page", () => {
  it("recordUsageEvent ignores probe events", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const { recordUsageEvent } = await import("@/lib/usageStats.js");

    await recordUsageEvent({ ok: false, provider: "oc", model: "step-5-preview-free", reason: "400", probe: true });
    const count = db.get(`SELECT COUNT(*) c FROM usageHistory`).c;
    expect(count).toBe(0);
  });
});
