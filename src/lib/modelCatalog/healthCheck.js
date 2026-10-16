// Model health (fork-owned, model-health phase).
//
// The Zen live list and the models.dev copy are CATALOGUES, not health checks:
// a model can vanish from both while still answering (step-5-preview-free is
// `status: "deprecated"` upstream yet served today — verified by probe), and a
// listed model can die while both still carry it. This module probes the
// models we actually list but that are NOT in the live list, and hides a model
// ONLY on definitive, repeated evidence that upstream no longer serves it:
//
//   * HTTP 200                     -> alive: strikes reset, hidden cleared
//   * 400/404 + gone signature     -> candidate; confirmed with a canary probe
//                                     of a live-listed model, so a platform
//                                     outage can never cost a model its place
//                                     (recorded as `unverified`, no strike)
//   * anything else (429/5xx/…/0)  -> inconclusive: the strike streak stands
//
// `MODEL_HEALTH_STRIKES` (default 10) consecutive confirmed-gone probes hide
// the id: /v1/models and /api/models drop it and the hourly config refresh
// removes it from opencode.jsonc. A later 200 — or a reappearance in the live
// list — unhides it. Hidden ids keep being probed, so recovery is automatic.
// While a model answers, it stays listed even when absent from every catalogue:
// quiet upstreams serve these ids fast, which is exactly what makes them useful.
import { getCustomModels } from "@/lib/localDb";
import { deleteModelHealth, listModelHealth, upsertModelHealth } from "@/lib/db/repos/modelHealthRepo.js";
import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import { getCatalogRawModelIds, getLiveModelIds } from "./liveModels.js";

const GONE_SIGNATURES = [
  /model is unavailable/i,
  /model not found/i,
  /unknown model/i,
  /does not exist/i,
];

const PROVIDER_ID = "opencode";
const PROVIDER_ALIASES = new Set(["oc", "opencode"]);

function envMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const baseUrl = () =>
  String(process.env.MODEL_HEALTH_BASE_URL || `http://127.0.0.1:${process.env.PORT || 20128}`).replace(/\/+$/, "");
const strikeThreshold = () => {
  const n = Number(process.env.MODEL_HEALTH_STRIKES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
};
const probeTimeoutMs = () => envMs("MODEL_HEALTH_TIMEOUT_MS", 25_000);
const startupDelayMs = () => envMs("MODEL_HEALTH_STARTUP_DELAY_MS", 3 * 60_000);
const baseIntervalMs = () => envMs("MODEL_HEALTH_INTERVAL_MS", 60 * 60_000);
const midIntervalMs = () => envMs("MODEL_HEALTH_MID_INTERVAL_MS", 30 * 60_000);
const fastIntervalMs = () => envMs("MODEL_HEALTH_FAST_INTERVAL_MS", 15 * 60_000);
const staggerMs = () => envMs("MODEL_HEALTH_STAGGER_MS", 2_500);

let timer = null;
let running = null;
const suspectProbes = new Map(); // modelId -> last suspect-triggered run (cooldown)

// 30s read cache for the listing routes: /v1/models is fetched often, a kv
// SELECT per request is fine but pointless. Invalidated on every health write.
let filterCache = { at: 0, value: null };

export function invalidateHealthCache() {
  filterCache = { at: 0, value: null };
}

function log(line) {
  console.log(`[HEALTH] ${line}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function firstApiKey() {
  try {
    const keys = await getApiKeys();
    const active = (keys || []).find((k) => k && k.key && k.isActive !== false);
    return active?.key || null;
  } catch {
    return null;
  }
}

// One minimal non-stream chat through our own gateway: it runs the real
// per-model transport (openai / responses / claude), the pool chain, and the
// same code path a user hits. The x-9r-probe marker keeps the row out of the
// Usage stats.
async function probe(modelId, apiKey) {
  try {
    const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "x-9r-probe": "1",
      },
      body: JSON.stringify({
        model: `oc/${modelId}`,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 16,
        stream: false,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(probeTimeoutMs()),
    });
    const text = await res.text().catch(() => "");
    return { status: res.status, text };
  } catch (error) {
    return { status: 0, text: String(error?.message || error) };
  }
}

export function classifyProbeResult(status, text) {
  if (status === 200) return "alive";
  if ((status === 400 || status === 404) && GONE_SIGNATURES.some((re) => re.test(String(text || "")))) {
    return "candidate-gone";
  }
  if (status === 429) return "rate_limited";
  if (status >= 500 || status === 0) return "error";
  return "unknown";
}

// Candidate ids = the models the routes could ever list for this provider:
// registry entries + dashboard-added custom models (provider alias oc).
async function candidateIds() {
  const ids = new Set();
  try {
    const { default: registry } = await import("open-sse/providers/registry/index.js");
    const entry = registry.find((p) => p?.id === PROVIDER_ID);
    for (const model of entry?.models || []) if (model?.id) ids.add(String(model.id));
  } catch {
    /* registry unavailable — custom models below still count */
  }
  try {
    for (const model of await getCustomModels()) {
      const alias = model?.providerAlias || model?.provider;
      if (!PROVIDER_ALIASES.has(alias)) continue;
      if (model?.id) ids.add(String(model.id));
    }
  } catch {
    /* DB unavailable — rows below still count */
  }
  return ids;
}

/**
 * Ids worth probing: everything currently listed that the live list does NOT
 * cover (kept alive by the models.dev copy or past probes), plus every id with
 * a health row that is not live (hidden ids included, so recovery is caught).
 */
export async function collectProbeTargets() {
  const [live, rows] = await Promise.all([
    getLiveModelIds(PROVIDER_ID).catch(() => null),
    listModelHealth().catch(() => []),
  ]);
  const liveSet = new Set(live ?? []);
  const catalog = new Set(getCatalogRawModelIds(PROVIDER_ID, { freeOnly: true }));
  const healthAlive = new Set(rows.filter((r) => !r.hidden && r.lastStatus === "alive").map((r) => r.modelId));
  const candidates = await candidateIds();
  const listed = [...candidates].filter((id) => liveSet.has(id) || catalog.has(id) || healthAlive.has(id));
  const tracked = new Set([...listed, ...rows.map((r) => r.modelId)]);
  return [...tracked].filter((id) => !liveSet.has(id));
}

async function applyOutcome(modelId, outcome) {
  const now = new Date().toISOString();
  const prev = await upsertCarefulRow(modelId);
  if (outcome === "alive") {
    return upsertModelHealth(modelId, {
      strikes: 0,
      hidden: false,
      lastStatus: "alive",
      lastCheckedAt: now,
      lastAliveAt: now,
    });
  }
  if (outcome === "gone") {
    const strikes = (prev.strikes || 0) + 1;
    // Sticky: once hidden, stays hidden until a success/live-list recovery —
    // a later threshold change must not silently resurrect a dead model.
    const hidden = prev.hidden === true || strikes >= strikeThreshold();
    return upsertModelHealth(modelId, {
      strikes,
      hidden,
      lastStatus: "gone",
      lastCheckedAt: now,
      lastGoneAt: now,
    });
  }
  // Unverified / rate_limited / error / unknown: record the observation but
  // never move the strike streak either way.
  return upsertModelHealth(modelId, { lastStatus: outcome, lastCheckedAt: now });
}

async function upsertCarefulRow(modelId) {
  const { getModelHealth } = await import("@/lib/db/repos/modelHealthRepo.js");
  return (await getModelHealth(modelId)) || { strikes: 0, hidden: false };
}

/**
 * Run one probe pass. `only` allows a targeted probe (suspect hook / manual
 * trigger). Returns a summary; concurrent calls share the in-flight run.
 */
export async function runHealthCheck({ only = null } = {}) {
  if (running) return running;
  running = (async () => {
    try {
      const apiKey = await firstApiKey();
      if (!apiKey) {
        log("no active API key — probes skipped");
        return { probed: 0, reason: "no-api-key", results: [] };
      }

      const live = (await getLiveModelIds(PROVIDER_ID)) ?? [];
      const liveSet = new Set(live);

      // Prune rows whose model left the candidate universe entirely (custom
      // model deleted, registry entry gone) and is not live: nothing can list
      // it again without a new candidate, so the memory would be probe noise.
      // Skipped on targeted (`only`) runs so a single manual check never
      // deletes unrelated state.
      if (!only?.length) {
        const candidates = await candidateIds();
        for (const row of await listModelHealth()) {
          if (candidates.has(row.modelId) || liveSet.has(row.modelId)) continue;
          await deleteModelHealth(row.modelId);
          log(`${row.modelId} pruned (no longer a candidate)`);
        }
      }

      // The live list is authoritative for recovery: a hidden id that is live
      // again is unhidden before probing.
      for (const row of await listModelHealth()) {
        if (row.hidden && liveSet.has(row.modelId)) {
          await upsertModelHealth(row.modelId, { hidden: false, strikes: 0, lastStatus: "alive" });
          log(`${row.modelId} back in the live list → unhidden`);
        }
      }

      const targets = only?.length ? [...new Set(only)] : await collectProbeTargets();
      if (targets.length === 0) {
        return { probed: 0, reason: "no-targets", results: [] };
      }

      const canary = liveSet.has("big-pickle") ? "big-pickle" : live[0] || null;
      const results = [];
      for (const modelId of targets) {
        const result = await probe(modelId, apiKey);
        let outcome = classifyProbeResult(result.status, result.text);
        if (outcome === "candidate-gone") {
          if (!canary) {
            outcome = "unverified";
          } else {
            const pass = await probe(canary, apiKey);
            outcome = classifyProbeResult(pass.status, pass.text) === "alive" ? "gone" : "unverified";
          }
        }
        const row = await applyOutcome(modelId, outcome);
        results.push({
          model: modelId,
          outcome,
          status: result.status,
          strikes: row.strikes ?? 0,
          hidden: !!row.hidden,
        });
        log(
          `${modelId} → ${outcome} (HTTP ${result.status}, strikes ${row.strikes ?? 0}/${strikeThreshold()}` +
            `${row.hidden ? ", HIDDEN" : ""})`,
        );
        if (targets.length > 1) await sleep(staggerMs());
      }
      invalidateHealthCache();
      return { probed: results.length, canary, results };
    } catch (error) {
      log(`check failed: ${error?.message || error}`);
      return { probed: 0, reason: "error", error: String(error?.message || error), results: [] };
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * Fire-and-forget hook for real traffic: a request that failed with 400/404
 * is only a *suspicion* — schedule a probe (with its canary confirmation) so
 * an actively used model is verified within seconds, never judged by one
 * failure. Cooldown 60s per model, probe 5s later.
 */
export function markModelSuspect(providerId, modelId) {
  if (providerId !== PROVIDER_ID || !modelId) return;
  const now = Date.now();
  if (now - (suspectProbes.get(modelId) || 0) < 60_000) return;
  suspectProbes.set(modelId, now);
  const t = setTimeout(() => {
    runHealthCheck({ only: [String(modelId)] }).catch(() => {});
  }, 5_000);
  t.unref?.();
}

/**
 * Listing view for the routes: `hidden` ids to drop and `aliveExtras` to keep
 * even when both catalogues dropped them. Cached ~30s.
 */
export async function getModelHealthFilter(providerId) {
  if (providerId !== PROVIDER_ID) return { hidden: new Set(), aliveExtras: [] };
  const now = Date.now();
  if (filterCache.value && now - filterCache.at < 30_000) return filterCache.value;
  const rows = await listModelHealth().catch(() => []);
  const hidden = new Set();
  const aliveExtras = [];
  for (const row of rows) {
    if (row.hidden) {
      hidden.add(row.modelId);
      continue;
    }
    if (row.lastStatus === "alive") aliveExtras.push(row.modelId);
  }
  filterCache = { at: now, value: { hidden, aliveExtras } };
  return filterCache.value;
}

/**
 * Pure merge used by /v1/models: candidates ∩ (live ∪ models.dev ∪ health-
 * alive), live-only ids added, health-alive-only ids added, hidden dropped.
 * `reality === null` (no live/catalog info at all) keeps the candidates as-is.
 */
export function mergeListedIds({ mergedIds, reality, health }) {
  const alive = new Set([...(reality?.alive ?? []), ...(health?.aliveExtras ?? [])]);
  const hidden = health?.hidden ?? new Set();
  const ids = reality ? mergedIds.filter((id) => alive.has(id)) : [...mergedIds];
  for (const id of reality?.live ?? []) {
    if (!mergedIds.includes(id) && !ids.includes(id)) ids.push(id);
  }
  for (const id of health?.aliveExtras ?? []) {
    if (!mergedIds.includes(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.filter((id) => !hidden.has(id));
}

/**
 * Hourly probe loop (installed from instrumentation.js). Cadence is adaptive:
 * 1h baseline; 30m once a model has 3 strikes; 15m at 7+ — verification gets
 * faster as evidence piles up, while the decision itself never changes.
 * Disable with MODEL_HEALTH=off.
 */
export function startModelHealthCheck() {
  if (timer) return;
  if (String(process.env.MODEL_HEALTH || "").toLowerCase() === "off") return;

  const schedule = (delay) => {
    timer = setTimeout(async () => {
      let next = baseIntervalMs();
      try {
        const out = await runHealthCheck();
        const maxStrikes = Math.max(0, ...(out.results || []).map((r) => r.strikes || 0));
        if (maxStrikes >= 7) next = Math.min(next, fastIntervalMs());
        else if (maxStrikes >= 3) next = Math.min(next, midIntervalMs());
      } catch {
        /* runHealthCheck never throws; belt and braces */
      }
      schedule(next);
    }, delay);
    timer.unref?.();
  };
  schedule(startupDelayMs());
}

/** Test helper: forget the scheduler/timer/cooldown/cache state. */
export function resetModelHealthState() {
  clearTimeout(timer);
  timer = null;
  running = null;
  suspectProbes.clear();
  invalidateHealthCache();
}
