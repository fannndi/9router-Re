// Fork-owned usage stats: one row per upstream call (attempt) with the proxy
// pool that carried it, so the Usage page can show how the two exit IPs share
// the free-tier limits and which models fail. Written from the chat path
// (fire-and-forget), read by /api/usage-stats. See scripts/lean.mjs (pool-usage).
import {
  insertUsageRow,
  queryUsageTotals,
  queryUsageSlices,
  queryUsageModels,
  queryUsageFailReasons,
  queryRecentUsage,
  deleteUsageBefore,
} from "./db/repos/usageStatsRepo.js";
import { parseJson } from "./db/helpers/jsonCol.js";

export const USAGE_RANGE_IDS = ["today", "24h", "7d", "30d", "60d"];
export const DEFAULT_USAGE_RANGE = "24h";
export const RECENT_LIMIT = 30;

const RETENTION_DAYS = 90;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PROVIDER_ALIASES = { oc: "opencode" };

let lastPruneAt = 0;

export function normalizeProvider(provider) {
  const raw = String(provider || "opencode").toLowerCase();
  return PROVIDER_ALIASES[raw] || raw;
}

// Provider-prefixed ids arrive as "oc/<slug>"; keep just the slug so failure
// rows line up with the token rows written by the chat core.
export function normalizeModel(model) {
  const raw = String(model || "unknown");
  return raw.split("/").pop() || raw;
}

// Accepts every upstream usage shape seen in the chat core (OpenAI, Claude,
// Responses input_tokens_details, etc.) and returns canonical counts.
export function normalizeTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inTok = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outTok = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const cached = usage.cache_read_input_tokens
    ?? usage.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? 0;
  return {
    in: Math.max(0, Math.round(inTok)),
    out: Math.max(0, Math.round(outTok)),
    cached: Math.max(0, Math.round(cached)),
  };
}

// "Today" starts at local midnight; the rest are rolling windows. Timestamps in
// the DB are ISO-UTC, so the cutoff is converted with toISOString.
export function resolveUsageRange(range) {
  const id = USAGE_RANGE_IDS.includes(range) ? range : DEFAULT_USAGE_RANGE;
  const now = new Date();
  if (id === "today") {
    return { id, since: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString() };
  }
  const days = { "24h": 1, "7d": 7, "30d": 30, "60d": 60 }[id];
  return { id, since: new Date(now.getTime() - days * DAY_MS).toISOString() };
}

function schedulePrune() {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  const cutoff = new Date(now - RETENTION_DAYS * DAY_MS).toISOString();
  deleteUsageBefore(cutoff).catch(() => {});
}

/**
 * Record one upstream call (success or failure). Never throws and never blocks
 * the request path; returns a promise so tests can await the insert.
 *   ok:    { ok: true, provider, model, pool, poolKey, tokens }
 *   fail:  { ok: false, provider, model, pool, poolKey, reason }
 *
 * Guard: test suites that exercise the chat path without an isolated DATA_DIR
 * (e.g. the translator suites) would otherwise pollute the live ~/.9router DB.
 * Production never sets VITEST/NODE_ENV=test.
 */
export function recordUsageEvent(event = {}) {
  try {
    // model-health probes are not user traffic: never counted in the Usage page.
    if (event.probe === true) return Promise.resolve(false);

    const underTest = process.env.VITEST || process.env.NODE_ENV === "test";
    if (underTest && !process.env.DATA_DIR) return Promise.resolve(false);

    const ok = event.ok === true;
    const tokens = ok ? normalizeTokens(event.tokens) : null;
    if (ok && (!tokens || (tokens.in === 0 && tokens.out === 0))) return Promise.resolve(false);

    const row = {
      timestamp: new Date().toISOString(),
      provider: normalizeProvider(event.provider),
      model: normalizeModel(event.model),
      connectionId: event.connectionId || null,
      apiKey: null, // never persist the presented key
      endpoint: event.endpoint || null,
      promptTokens: tokens?.in ?? 0,
      completionTokens: tokens?.out ?? 0,
      status: ok ? "ok" : "fail",
      tokens: JSON.stringify(tokens || { in: 0, cached: 0, out: 0 }),
      meta: JSON.stringify({
        pool: event.pool || null,
        poolKey: event.poolKey || null,
        reason: ok ? null : (event.reason || "error"),
      }),
    };

    return insertUsageRow(row)
      .then(() => { schedulePrune(); return true; })
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

function modelKey(provider, model) {
  return `${provider || ""}|${model || ""}`;
}

/** Aggregated payload for the Usage page (totals, pools, models, recent). */
export async function getUsageOverview(range) {
  const { id, since } = resolveUsageRange(range);
  const [totalsRow, slices, models, reasons, recent] = await Promise.all([
    queryUsageTotals(since),
    queryUsageSlices(since),
    queryUsageModels(since),
    queryUsageFailReasons(since),
    queryRecentUsage(since, RECENT_LIMIT),
  ]);

  const attempts = Number(totalsRow?.attempts || 0);

  const reasonsByModel = new Map();
  for (const r of reasons) {
    const key = modelKey(r.provider, r.model);
    if (!reasonsByModel.has(key)) reasonsByModel.set(key, []);
    reasonsByModel.get(key).push({ reason: r.reason || "error", count: Number(r.n || 0) });
  }

  return {
    range: id,
    since,
    totals: {
      attempts,
      served: Number(totalsRow?.served || 0),
      failed: Number(totalsRow?.failed || 0),
      inTokens: Number(totalsRow?.inTokens || 0),
      cachedTokens: Number(totalsRow?.cachedTokens || 0),
      outTokens: Number(totalsRow?.outTokens || 0),
    },
    pools: slices.map((s) => ({
      label: s.label || "direct",
      count: Number(s.n || 0),
      pct: attempts ? (Number(s.n || 0) * 100) / attempts : 0,
    })),
    models: models.map((m) => {
      const rowAttempts = Number(m.attempts || 0);
      const fails = Number(m.fails || 0);
      return {
        provider: m.provider || "opencode",
        model: m.model || "unknown",
        attempts: rowAttempts,
        fails,
        failRate: rowAttempts ? (fails * 100) / rowAttempts : 0,
        inTokens: Number(m.inTokens || 0),
        cachedTokens: Number(m.cachedTokens || 0),
        outTokens: Number(m.outTokens || 0),
        lastAt: m.lastAt || null,
        reasons: reasonsByModel.get(modelKey(m.provider, m.model)) || [],
      };
    }),
    recent: recent.map((r) => {
      const meta = parseJson(r.meta, {}) || {};
      const tokens = parseJson(r.tokens, {}) || {};
      return {
        at: r.timestamp,
        provider: r.provider || "opencode",
        model: r.model || "unknown",
        pool: meta.pool || (r.status === "ok" ? "direct" : "unknown"),
        ok: r.status === "ok",
        reason: meta.reason || null,
        inTokens: Number(r.promptTokens || 0),
        outTokens: Number(r.completionTokens || 0),
        cachedTokens: Number(tokens.cached || 0),
      };
    }),
  };
}
