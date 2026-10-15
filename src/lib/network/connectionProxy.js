import { getProxyPoolById } from "@/models";
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
         * Vercel/Cloudflare/Deno/Netlify relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify") {
          return {
            source: proxyPool.type,

            proxyPoolId,
            proxyPool,

            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,

            strictProxy: proxyPool.strictProxy === true,

            vercelRelayUrl: proxyUrl, // Still mapped to vercelRelayUrl in the unified payload since they use the exact same header spec
          };
        }

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
export const DIRECT_POOL_KEY = "__direct__";

// A rate limit belongs to a time window, not to a broken proxy: the floor
// keeps a limited entry out of rotation past a burst window, the cap stops a
// daily-quota Retry-After (hours) from parking an entry for the whole day.
// Entries are still available again once the cooldown expires, and
// noteProxyPoolSuccess() clears it immediately after a good response.
const POOL_COOLDOWN_MIN_MS = 30 * 1000;
const POOL_COOLDOWN_MAX_MS = 60 * 60 * 1000;

const poolHealth = new Map(); // key → { backoffLevel, cooldownUntil }

function healthKey(poolKey) {
  return poolKey || DIRECT_POOL_KEY;
}

export function isProxyPoolCoolingDown(poolKey) {
  const state = poolHealth.get(healthKey(poolKey));
  return !!(state && state.cooldownUntil > Date.now());
}

export function getProxyPoolCooldownUntil(poolKey) {
  const state = poolHealth.get(healthKey(poolKey));
  return state && state.cooldownUntil > Date.now() ? state.cooldownUntil : 0;
}

/**
 * Record a failed attempt against a chain entry.
 * @returns {number} applied cooldown in ms (0 when the error is not worth one)
 */
export function noteProxyPoolFailure(poolKey, status, errorText, retryAfterMs = 0) {
  const key = healthKey(poolKey);
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

export function noteProxyPoolSuccess(poolKey) {
  poolHealth.delete(healthKey(poolKey));
}

export function resetProxyPoolHealth() {
  poolHealth.clear();
}

/**
 * Pick the next entry of a failover chain for one request.
 *
 * Entries already tried by this request are skipped first, then entries on
 * cooldown. When every remaining entry is cooling down the one that recovers
 * first is used anyway: failing fast on a stale cooldown is worse than one
 * more try. Returns null when the request already tried every entry.
 */
export function pickChainEntry(chain, attemptedKeys = new Set()) {
  if (!Array.isArray(chain) || chain.length === 0) return null;

  const remaining = chain.filter((entry) => entry && !attemptedKeys.has(entry.key));
  if (remaining.length === 0) return null;

  const ready = remaining.find((entry) => !isProxyPoolCoolingDown(entry.key));
  if (ready) return ready;

  return remaining.reduce((best, entry) =>
    getProxyPoolCooldownUntil(entry.key) < getProxyPoolCooldownUntil(best.key) ? entry : best
  );
}
