// Unit tests for the fork-owned usage stats recorder/aggregator (pool-usage
// phase): one row per upstream call in usageHistory, with pool attribution.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function loadModules() {
  const usage = await import("@/lib/usageStats.js");
  const repo = await import("@/lib/db/repos/usageStatsRepo.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  await getAdapter(); // runs migrations → creates usageHistory
  return { usage, repo };
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("resolveUsageRange", () => {
  it("falls back to 24h for unknown ranges", async () => {
    const { usage } = await loadModules();
    const { id, since } = usage.resolveUsageRange("bogus");
    expect(id).toBe("24h");
    expect(Math.abs(Date.now() - new Date(since).getTime() - 24 * 60 * 60 * 1000)).toBeLessThan(5000);
  });

  it("uses local midnight for today", async () => {
    const { usage } = await loadModules();
    const { id, since } = usage.resolveUsageRange("today");
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    expect(id).toBe("today");
    expect(new Date(since).getTime()).toBe(midnight.getTime());
  });

  it("maps rolling windows to their day counts", async () => {
    const { usage } = await loadModules();
    for (const [range, days] of [["7d", 7], ["30d", 30], ["60d", 60]]) {
      const { since } = usage.resolveUsageRange(range);
      const diffDays = (Date.now() - new Date(since).getTime()) / (24 * 60 * 60 * 1000);
      expect(Math.abs(diffDays - days)).toBeLessThan(0.01);
    }
  });
});

describe("normalize helpers", () => {
  it("normalizes OpenAI, Claude and Responses usage shapes", async () => {
    const { usage } = await loadModules();
    expect(usage.normalizeTokens({
      prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 },
    })).toEqual({ in: 100, out: 20, cached: 64 });

    expect(usage.normalizeTokens({
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 8,
    })).toEqual({ in: 10, out: 5, cached: 8 });

    expect(usage.normalizeTokens({
      input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 },
    })).toEqual({ in: 10, out: 2, cached: 4 });

    expect(usage.normalizeTokens(null)).toBeNull();
  });

  it("strips the provider alias from model and provider", async () => {
    const { usage } = await loadModules();
    expect(usage.normalizeModel("oc/space-bunny-free")).toBe("space-bunny-free");
    expect(usage.normalizeModel("muse-spark-1.3-contributor-free")).toBe("muse-spark-1.3-contributor-free");
    expect(usage.normalizeProvider("oc")).toBe("opencode");
    expect(usage.normalizeProvider("OpenCode")).toBe("opencode");
    expect(usage.normalizeProvider(null)).toBe("opencode");
  });
});

describe("recordUsageEvent + getUsageOverview", () => {
  it("records ok rows with tokens and fail rows with a reason", async () => {
    const { usage, repo } = await loadModules();

    await usage.recordUsageEvent({ ok: true, provider: "opencode", model: "space-bunny-free", pool: "Local (host)", tokens: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } });
    await usage.recordUsageEvent({ ok: true, provider: "opencode", model: "space-bunny-free", pool: "Local (host)", tokens: { prompt_tokens: 50, completion_tokens: 10, cached_tokens: 30 } });
    await usage.recordUsageEvent({ ok: true, provider: "oc", model: "oc/muse-spark-1.3-contributor-free", pool: "Mobile (phone tether)", tokens: { input_tokens: 200, output_tokens: 5, input_tokens_details: { cached_tokens: 150 } } });
    await usage.recordUsageEvent({ ok: false, provider: "opencode", model: "space-bunny-free", pool: "Local (host)", reason: "429" });
    await usage.recordUsageEvent({ ok: false, provider: "oc", model: "oc/muse-spark-1.3-contributor-free", reason: "empty" });

    const overview = await usage.getUsageOverview("24h");
    expect(overview.totals).toEqual({
      attempts: 5,
      served: 3,
      failed: 2,
      inTokens: 350,
      cachedTokens: 220,
      outTokens: 35,
    });

    const byLabel = Object.fromEntries(overview.pools.map((p) => [p.label, p]));
    expect(byLabel.Fail.count).toBe(2);
    expect(byLabel["Local (host)"].count).toBe(2);
    expect(byLabel["Mobile (phone tether)"].count).toBe(1);
    const pctSum = overview.pools.reduce((sum, p) => sum + p.pct, 0);
    expect(pctSum).toBeCloseTo(100, 5);

    const spark = overview.models.find((m) => m.model === "muse-spark-1.3-contributor-free");
    expect(spark.provider).toBe("opencode");
    expect(spark.attempts).toBe(2);
    expect(spark.fails).toBe(1);
    expect(spark.failRate).toBe(50);
    expect(spark.reasons).toEqual([{ reason: "empty", count: 1 }]);

    const bunny = overview.models.find((m) => m.model === "space-bunny-free");
    expect(bunny.attempts).toBe(3);
    expect(bunny.fails).toBe(1);
    expect(bunny.inTokens).toBe(150);
    expect(bunny.cachedTokens).toBe(70);
    expect(bunny.reasons).toEqual([{ reason: "429", count: 1 }]);

    const rows = await repo.queryRecentUsage(overview.since, 30);
    expect(rows.length).toBe(5);

    const unknownPoolFail = overview.recent.find((r) => !r.ok && r.reason === "empty");
    expect(unknownPoolFail.pool).toBe("unknown");
  });

  it("skips ok events without usable tokens and never throws", async () => {
    const { usage } = await loadModules();
    expect(await usage.recordUsageEvent({ ok: true, model: "x", tokens: { prompt_tokens: 0, completion_tokens: 0 } })).toBe(false);
    expect(await usage.recordUsageEvent({ ok: true, model: "x" })).toBe(false);
    expect(await usage.recordUsageEvent({ ok: false, model: "y" })).toBe(true); // reason defaults to "error"
    const overview = await usage.getUsageOverview("24h");
    expect(overview.totals.attempts).toBe(1);
    expect(overview.models[0].reasons).toEqual([{ reason: "error", count: 1 }]);
  });

  it("filters by range and orders recent rows newest first", async () => {
    const { usage, repo } = await loadModules();

    await usage.recordUsageEvent({ ok: true, model: "fresh", pool: "Local (host)", tokens: { prompt_tokens: 5, completion_tokens: 1 } });
    await repo.insertUsageRow({
      timestamp: daysAgoIso(30),
      provider: "opencode",
      model: "month-old",
      connectionId: null,
      apiKey: null,
      endpoint: null,
      promptTokens: 999,
      completionTokens: 99,
      status: "ok",
      tokens: JSON.stringify({ in: 999, cached: 0, out: 99 }),
      meta: JSON.stringify({ pool: "Local (host)", poolKey: null, reason: null }),
    });

    const week = await usage.getUsageOverview("7d");
    expect(week.totals.attempts).toBe(1);
    expect(week.models.map((m) => m.model)).toEqual(["fresh"]);

    const twoMonths = await usage.getUsageOverview("60d");
    expect(twoMonths.totals.attempts).toBe(2);
    expect(twoMonths.recent.map((r) => r.model)).toEqual(["fresh", "month-old"]);
    expect(twoMonths.recent[0].ok).toBe(true);
    expect(twoMonths.recent[0].pool).toBe("Local (host)");
  });

  it("prunes rows older than the retention cutoff", async () => {
    const { usage, repo } = await loadModules();
    await usage.recordUsageEvent({ ok: true, model: "fresh", tokens: { prompt_tokens: 1, completion_tokens: 1 } });
    await repo.insertUsageRow({
      timestamp: daysAgoIso(120),
      provider: "opencode",
      model: "ancient",
      connectionId: null,
      apiKey: null,
      endpoint: null,
      promptTokens: 1,
      completionTokens: 1,
      status: "ok",
      tokens: JSON.stringify({ in: 1, cached: 0, out: 1 }),
      meta: JSON.stringify({}),
    });

    await repo.deleteUsageBefore(daysAgoIso(90));
    const row = await repo.queryUsageTotals(daysAgoIso(365));
    expect(Number(row.attempts)).toBe(1);
  });
});
