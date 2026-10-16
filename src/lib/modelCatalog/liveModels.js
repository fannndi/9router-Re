// Live model list for providers whose catalogue is owned upstream (the registry
// `modelsFetcher`). Fork-owned (zen-caps phase).
//
// OpenCode Free's Zen endpoint rotates its free models during the day, so a
// static list goes stale: union-alpha was retired, jev-1.13-free appeared, and
// step-5-preview-free was missing from a live spot check hours after it was
// listed. /v1/models and the dashboard use this module to keep the listing
// honest, and the daily models.dev sync uses it to refresh the limits of every
// servable id instead of only the few named in the registry.
import fs from "node:fs";
import registry from "open-sse/providers/registry/index.js";
import { CATALOG_RAW_FILE } from "open-sse/providers/catalogOverride.js";
import { FILTERS } from "@/app/api/providers/suggested-models/filters.js";

export const LIVE_TTL_MS = 10 * 60 * 1000;
const LIVE_TIMEOUT_MS = 5000;
const liveCache = new Map(); // providerId -> { ids, at }

function registryEntry(providerId) {
  return registry.find((p) => p?.id === providerId) || null;
}

function providerFilter(providerId) {
  const type = registryEntry(providerId)?.modelsFetcher?.type;
  return (type && FILTERS[type]) || null;
}

export function clearLiveModelCache() {
  liveCache.clear();
}

/**
 * Live free-model ids from the provider's modelsFetcher, filtered exactly like
 * the dashboard "suggested models" list. Cached for LIVE_TTL_MS; a failed
 * refresh falls back to the last good copy.
 * Returns null when there is nothing to go on (no fetcher, or the fetch failed
 * with no cached copy) — callers must then keep their current, unfiltered view.
 */
export async function getLiveModelIds(providerId, { ttlMs = LIVE_TTL_MS, timeoutMs = LIVE_TIMEOUT_MS } = {}) {
  const cached = liveCache.get(providerId);
  if (cached && Date.now() - cached.at < ttlMs) return cached.ids;

  const entry = registryEntry(providerId);
  const fetcher = entry?.modelsFetcher;
  const filter = providerFilter(providerId);
  if (!fetcher?.url || !filter) return cached?.ids ?? null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(fetcher.url, {
      headers: { accept: "application/json", ...(entry?.transport?.headers || {}) },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const raw = Array.isArray(body?.data) ? body.data : [];
    const ids = filter(raw).map((m) => m.id).filter(Boolean);
    liveCache.set(providerId, { ids, at: Date.now() });
    return ids;
  } catch {
    return cached?.ids ?? null;
  }
}

/**
 * Model ids the models.dev copy (model-catalog-raw.json, refreshed by the daily
 * sync) knows for this provider. `freeOnly` applies the provider's fetcher
 * filter so paid ids cannot keep retired free entries alive.
 */
export function getCatalogRawModelIds(providerId, { freeOnly = false } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_RAW_FILE, "utf8"));
    const models = raw?.[providerId];
    if (!models || typeof models !== "object") return [];
    let ids = Object.keys(models);
    const filter = freeOnly ? providerFilter(providerId) : null;
    if (filter) ids = filter(ids.map((id) => ({ id }))).map((m) => m.id);
    return ids;
  } catch {
    return [];
  }
}

/**
 * "What exists upstream" for a fetch-owned provider: live ids ∪ models.dev free
 * ids. The second opinion keeps models that are only temporarily missing from
 * the live list (step-5-preview-free) while still retiring ids that vanished
 * from both (union-alpha). Returns null when nothing is known.
 */
export async function getModelReality(providerId) {
  const live = await getLiveModelIds(providerId);
  const catalog = getCatalogRawModelIds(providerId, { freeOnly: true });
  if (live === null && catalog.length === 0) return null;
  return {
    live: live ?? [],
    alive: new Set([...(live ?? []), ...catalog]),
  };
}
