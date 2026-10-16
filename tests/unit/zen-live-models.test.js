// Live model-list helpers (zen-caps phase): fetch + cache + filter of the
// upstream-owned catalogue, the models.dev second opinion, and the combined
// "what exists upstream" view used by /v1/models, /api/models and the sync.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-live-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function writeRawCatalog(catalog) {
  fs.writeFileSync(path.join(tempDir, "model-catalog-raw.json"), JSON.stringify(catalog), "utf8");
}

const ZEN_PAYLOAD = {
  data: [
    { id: "big-pickle" },
    { id: "step-5-preview-free" },
    { id: "union-alpha" },
    { id: "deepseek-v4-flash-free" }, // retired: the filter drops it
    { id: "claude-opus-5" },          // paid: dropped
    { id: "test" },                   // not a model: dropped
  ],
};

describe("live model list (zen-caps)", () => {
  it("fetches, filters to free ids and caches within the TTL", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ZEN_PAYLOAD }));
    vi.stubGlobal("fetch", fetchMock);
    const { getLiveModelIds } = await import("@/lib/modelCatalog/liveModels.js");

    expect(await getLiveModelIds("opencode")).toEqual(["big-pickle", "step-5-preview-free"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await getLiveModelIds("opencode");
    expect(fetchMock).toHaveBeenCalledTimes(1); // served from cache
  });

  it("keeps the last good copy when a refresh fails, and returns null without one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ZEN_PAYLOAD })));
    const mod = await import("@/lib/modelCatalog/liveModels.js");
    await mod.getLiveModelIds("opencode");

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await mod.getLiveModelIds("opencode", { ttlMs: 0 })).toEqual(["big-pickle", "step-5-preview-free"]);

    mod.clearLiveModelCache();
    expect(await mod.getLiveModelIds("opencode", { ttlMs: 0 })).toBeNull();
  });

  it("returns null for providers without a live fetcher", async () => {
    const { getLiveModelIds } = await import("@/lib/modelCatalog/liveModels.js");
    expect(await getLiveModelIds("opencode-go")).toBeNull();
  });

  it("reads the models.dev copy and applies the free filter when asked", async () => {
    writeRawCatalog({
      opencode: {
        "step-5-preview-free": { c: 1000000, o: 65536 },
        "union-alpha": { c: 262144 },
        "claude-opus-5": { c: 200000 },
        "deepseek-v4-flash-free": { c: 1000000 },
      },
    });
    const { getCatalogRawModelIds } = await import("@/lib/modelCatalog/liveModels.js");
    expect(getCatalogRawModelIds("opencode").sort()).toEqual([
      "claude-opus-5",
      "deepseek-v4-flash-free",
      "step-5-preview-free",
      "union-alpha",
    ]);
    expect(getCatalogRawModelIds("opencode", { freeOnly: true })).toEqual(["step-5-preview-free"]);
  });

  it("merges live ∪ models.dev: retired ids die, temporarily-missing ids survive", async () => {
    writeRawCatalog({ opencode: { "step-5-preview-free": { c: 1000000, o: 65536 } } });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "jev-1.13-free" }, { id: "union-alpha" }] }),
    })));
    const { getModelReality } = await import("@/lib/modelCatalog/liveModels.js");

    const reality = await getModelReality("opencode");
    expect(reality.live).toEqual(["jev-1.13-free"]);
    expect(reality.alive.has("jev-1.13-free")).toBe(true);       // live-only: new model appears
    expect(reality.alive.has("step-5-preview-free")).toBe(true); // models.dev-only: temporary absence
    expect(reality.alive.has("union-alpha")).toBe(false);        // gone from both → retired
  });

  it("returns null when nothing is known (fetch failed, no catalog)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { getModelReality } = await import("@/lib/modelCatalog/liveModels.js");
    expect(await getModelReality("opencode")).toBeNull();
  });
});
