import { getProxyPoolById, getProxyPools } from "@/models";
import { getSettings } from "@/lib/localDb";
import { checkFallbackError } from "open-sse/services/accountFallback.js";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// ─── Proxy pool rotation state (in-memory) ─────────────────────────
const rotateState = new Map(); // providerId → { index }

/**
 * Pick one proxy pool ID from a list based on strategy.
 * round-robin: cycle sequentially (in-memory, resets on restart)
 * random:      uniform random pick
 * none/single: return first entry
 */
export function pickProxyPoolId(poolIds, strategy, providerId) {
  if (!poolIds || poolIds.length === 0) return null;
  if (poolIds.length === 1) return poolIds[0];

  if (strategy === "round-robin") {
    const state = rotateState.get(providerId) || { index: -1 };
    state.index = (state.index + 1) % poolIds.length;
    rotateState.set(providerId, state);
    return poolIds[state.index];
  }

  if (strategy === "random") {
    return poolIds[Math.floor(Math.random() * poolIds.length)];
  }

  return poolIds[0]; // "none" or unknown
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Proxy Pool
 * 2. Legacy Proxy
 * 3. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {}
) {
  try {
    const proxyPoolIdRaw = normalizeString(
      providerSpecificData?.proxyPoolId
    );

    // "__none__" means explicitly disabled
    const proxyPoolId =
      proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    // A strict pool must keep its guarantee even when the pool itself is not
    // usable (inactive, or saved without a url). Otherwise the unusable-pool
    // path below reports strictProxy:false and the request silently leaves
    // over the direct IP — the leak strict mode exists to prevent (#4333).
    let poolStrictProxy = false;

    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      const proxyPool = await getProxyPoolById(proxyPoolId);

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        proxyUrl;

      poolStrictProxy = proxyPool?.strictProxy === true;

      if (isValidPool) {
        /**
         * Standard proxy pool
         */
        return {
          source: "pool",

          proxyPoolId,
          proxyPool,

          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          connectionNoProxy: noProxy,

          strictProxy: proxyPool.strictProxy === true,
        };
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolId || null,
        proxyPool: null,

        strictProxy: poolStrictProxy,

        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      strictProxy: poolStrictProxy,

      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
    };
  }
}

// ─── Pool failover state (in-memory) ───────────────────────────────
// Failover mode (settings.providerStrategies[provider].rotateStrategy ===
// "failover") walks an ordered chain: direct first, then the selected pool.
// An entry that answers 429 is put on a cooldown so the next request skips it
// instead of paying a fresh round trip to the same wall. Direct is a chain
// entry like any other and is keyed by DIRECT_POOL_KEY.
//
// Cooldowns are scoped per model on purpose: free-tier limits are handed out
// per IP *and* per model (one model can be exhausted while another still
// answers), so a limited model must not park the whole entry for its siblings.
export const DIRECT_POOL_KEY = "__direct__";

// A rate limit belongs to a time window, not to a broken proxy: the floor
// keeps a limited entry out of rotation past a burst window, the cap stops a
// daily-quota Retry-After (hours) from parking an entry for the whole day.
// Entries are still available again once the cooldown expires, and
// noteProxyPoolSuccess() clears it immediately after a good response.
const POOL_COOLDOWN_MIN_MS = 30 * 1000;
const POOL_COOLDOWN_MAX_MS = 60 * 60 * 1000;

const poolHealth = new Map(); // "poolKey::model" → { backoffLevel, cooldownUntil }

function healthKey(poolKey, model = "") {
  return `${poolKey || DIRECT_POOL_KEY}::${model || ""}`;
}

export function isProxyPoolCoolingDown(poolKey, model = "") {
  const state = poolHealth.get(healthKey(poolKey, model));
  return !!(state && state.cooldownUntil > Date.now());
}

export function getProxyPoolCooldownUntil(poolKey, model = "") {
  const state = poolHealth.get(healthKey(poolKey, model));
  return state && state.cooldownUntil > Date.now() ? state.cooldownUntil : 0;
}

/**
 * Record a failed attempt against a chain entry.
 * @returns {number} applied cooldown in ms (0 when the error is not worth one)
 */
export function noteProxyPoolFailure(poolKey, status, errorText, retryAfterMs = 0, model = "") {
  const key = healthKey(poolKey, model);
  const prev = poolHealth.get(key) || { backoffLevel: 0, cooldownUntil: 0 };
  const { shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(
    status,
    errorText,
    prev.backoffLevel
  );
  const level = newBackoffLevel ?? prev.backoffLevel;
  const retryAfter = Number(retryAfterMs);
  const requested = retryAfter > 0 ? retryAfter : (shouldFallback ? cooldownMs : 0);

  if (requested <= 0) {
    poolHealth.set(key, { backoffLevel: level, cooldownUntil: prev.cooldownUntil });
    return 0;
  }

  const cooldown = Math.min(Math.max(requested, POOL_COOLDOWN_MIN_MS), POOL_COOLDOWN_MAX_MS);
  poolHealth.set(key, { backoffLevel: level, cooldownUntil: Date.now() + cooldown });
  return cooldown;
}

export function noteProxyPoolSuccess(poolKey, model = "") {
  poolHealth.delete(healthKey(poolKey, model));
}

export function resetProxyPoolHealth() {
  poolHealth.clear();
}

/**
 * Pick the next entry of a failover chain for one request.
 *
 * Entries already tried by this request are skipped first, then entries on
 * cooldown for this model. When every remaining entry is cooling down the one
 * that recovers first is used anyway: failing fast on a stale cooldown is
 * worse than one more try. Returns null when the request already tried every
 * entry.
 */
export function pickChainEntry(chain, attemptedKeys = new Set(), model = "") {
  if (!Array.isArray(chain) || chain.length === 0) return null;

  const remaining = chain.filter((entry) => entry && !attemptedKeys.has(entry.key));
  if (remaining.length === 0) return null;

  const ready = remaining.find((entry) => !isProxyPoolCoolingDown(entry.key, model));
  if (ready) return ready;

  return remaining.reduce((best, entry) =>
    getProxyPoolCooldownUntil(entry.key, model) < getProxyPoolCooldownUntil(best.key, model) ? entry : best
  );
}

// ─── Per-request pool chain ────────────────────────────────────────────────
// The chat loop builds ONE plan per client request (so round-robin advances its
// start pool exactly once per request, not once per retry) and then walks the
// chain on pool-worthy failures. Entry shape: { key, poolId, label }.
//
//   failover     → [ direct, ...pools ]      pools = selected pool, or all
//                                            active pools ordered by
//                                            `failoverOrder` (then createdAt)
//                                            when "__all__" is selected
//   round-robin  → [...pools rotated to the next start index]
//   random       → [...pools starting at a random index]
//   none         → [ selectedPool ]          (or [] → direct)
export const ALL_POOLS_KEY = "__all__";
export const NONE_POOL_KEY = "__none__";
const DIRECT_LABEL = "direct";
const DEFAULT_FAILOVER_ORDER = 100;

function poolFailoverOrder(pool) {
  const n = Number(pool?.failoverOrder);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FAILOVER_ORDER;
}

/** Active pools with a URL, ordered for the failover chain. */
export async function getOrderedActivePools() {
  const pools = await getProxyPools({ isActive: true });
  return pools
    .filter((pool) => String(pool?.proxyUrl || "").trim())
    .sort((a, b) => (poolFailoverOrder(a) - poolFailoverOrder(b))
      || (new Date(a.createdAt || 0) - new Date(b.createdAt || 0)));
}

// Pool names for log lines. Short TTL so a rename shows up without a restart.
const poolNameCache = new Map(); // id → { name, at }
const POOL_NAME_TTL_MS = 10 * 1000;

export async function getPoolName(poolId) {
  if (!poolId) return null;
  const hit = poolNameCache.get(poolId);
  if (hit && Date.now() - hit.at < POOL_NAME_TTL_MS) return hit.name;
  try {
    const pool = await getProxyPoolById(poolId);
    const name = pool?.name || null;
    poolNameCache.set(poolId, { name, at: Date.now() });
    return name;
  } catch {
    return null;
  }
}

/**
 * Build the ordered chain of pool entries a single client request may use.
 * @returns {{ strategy: string, chain: Array<{key: string, poolId: string|null, label: string}> }}
 */
export async function buildPoolPlan(providerId, settings = null) {
  const resolvedSettings = settings || await getSettings();
  const override = (resolvedSettings?.providerStrategies || {})[providerId] || {};
  const strategy = override.rotateStrategy || "none";
  const selected = String(override.proxyPoolId || "").trim();

  const toEntry = (pool) => ({
    key: pool.id,
    poolId: pool.id,
    label: pool.name || pool.id.slice(0, 8),
  });

  let chain = [];

  if (strategy === "failover") {
    chain = [{ key: DIRECT_POOL_KEY, poolId: null, label: DIRECT_LABEL }];
    const activePools = await getOrderedActivePools();
    if (selected === ALL_POOLS_KEY) {
      chain.push(...activePools.map(toEntry));
    } else if (selected && selected !== NONE_POOL_KEY) {
      const pool = activePools.find((p) => p.id === selected);
      if (pool) chain.push(toEntry(pool));
    }
  } else if (strategy === "round-robin" || strategy === "random") {
    const activePools = await getOrderedActivePools();
    if (activePools.length > 0) {
      // pickProxyPoolId advances the in-memory rotation state; calling it once
      // per plan keeps the start pool alternating once per client request.
      const startId = pickProxyPoolId(activePools.map((p) => p.id), strategy, providerId);
      const idx = Math.max(0, activePools.findIndex((p) => p.id === startId));
      chain = [...activePools.slice(idx), ...activePools.slice(0, idx)].map(toEntry);
    }
  } else if (selected && selected !== NONE_POOL_KEY && selected !== ALL_POOLS_KEY) {
    const activePools = await getOrderedActivePools();
    const pool = activePools.find((p) => p.id === selected);
    if (pool) chain = [toEntry(pool)];
  }

  return { strategy, chain, useAllPools: selected === ALL_POOLS_KEY };
}

