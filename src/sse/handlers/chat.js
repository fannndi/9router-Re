import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { getKeyAccessContext, enforceKeyAccess } from "../services/keyAccess.js";
import { noteProxyPoolFailure, noteProxyPoolSuccess, buildPoolPlan, getPoolName, DIRECT_POOL_KEY } from "@/lib/network/connectionProxy";
import { recordUsageEvent } from "@/lib/usageStats.js";

/**
 * Retry-After of a failed upstream response, in milliseconds (0 when absent).
 * Providers that answer a rate limit with a reset hint (OpenCode Zen sends a
 * daily-window Retry-After) get an honest pool cooldown out of it; the cap
 * lives in noteProxyPoolFailure.
 */
function poolRetryAfterMs(result) {
  const headers = upstreamResponseHeaders(result?.response?.headers);
  const raw = headers["retry-after"];
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const when = Date.parse(raw);
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  }
  const resetsAt = Number(result?.resetsAtMs);
  if (Number.isFinite(resetsAt) && resetsAt > Date.now()) return resetsAt - Date.now();
  return 0;
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Per-key access control: a restricted key may call only the models in its
  // allow list. Checked once on the requested target, before bypass and any
  // credential lookup.
  const keyAccess = await getKeyAccessContext(request);
  const keyAccessDenied = await enforceKeyAccess(keyAccess, modelStr);
  if (keyAccessDenied) return keyAccessDenied;

  // Bypass naming/warmup requests before any credential or rotation work
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, contextMarker ? `${modelStr.slice(modelStr.indexOf("/") + 1)}[${contextMarker}]` : null);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, requestedModel = null) {
  const modelInfo = await getModelInfo(modelStr);

  // A null provider means the string matched no provider, alias or node.
  if (!modelInfo.provider) {
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  // Pool-chain state for this request: which entries (direct / pools) were
  // already tried. The chain itself comes from buildPoolPlan below.
  const failoverState = { attempted: new Set(), bestError: null };
  // One pool chain per client request: round-robin advances its start pool here
  // (not once per retry), and the loop below walks the chain on pool-worthy
  // failures (429 / 5xx / transport).
  const poolPlan = await buildPoolPlan(provider);
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { requestedModel: requestedModel || model, failoverState, poolPlan });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman, lastHeaders);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Name the pool in the request "▶" line. No-auth providers already carry
    // the label from the plan; compat connections resolve it from their own
    // proxyPoolId here (single cached lookup).
    const credPsd = refreshedCredentials?.providerSpecificData;
    if (credPsd && !credPsd.connectionProxyPoolName && credPsd.connectionProxyPoolId) {
      credPsd.connectionProxyPoolName = await getPoolName(credPsd.connectionProxyPoolId);
    }

    // Tag this attempt with the pool that will carry it, so the token rows
    // written in the chatCore handlers can be attributed (Usage page).
    if (clientRawRequest) {
      clientRawRequest._poolName = refreshedCredentials?._poolFailover?.label
        || credPsd?.connectionProxyPoolName
        || null;
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      providerThinking,
      // Per-provider user overrides (custom headers / connect timeout) from settings
      providerOverrides: (chatSettings.providerOverrides || {})[provider] || null,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    if (!result.success) {
      // One row per failed attempt (pool + reason) so the Usage page can count
      // fails per model and per exit IP.
      recordUsageEvent({
        ok: false,
        provider,
        model,
        pool: credentials._poolFailover?.label || credPsd?.connectionProxyPoolName || null,
        poolKey: credentials._poolFailover?.key || null,
        reason: result.status ? String(result.status) : "transport",
        endpoint: clientRawRequest?.endpoint || null,
      });
    }

    if (result.success) {
      const usedPool = credentials._poolFailover || null;
      if (usedPool) noteProxyPoolSuccess(usedPool.key, model);
      if (usedPool && usedPool.key !== DIRECT_POOL_KEY && failoverState.attempted.size > 0) {
        log.info("POOL", `✔ POOL:"${usedPool.label || usedPool.key}" served the request after ${failoverState.attempted.size} failed attempt(s)`);
      }
      return result.response;
    }

    // Pool failover: a 429 belongs to the exit IP, not to the credential, so
    // retry the same request through the next chain entry (usually the mobile
    // pool) before locking the account. 5xx and transport failures move on the
    // same way; the failed entry just cools down so later requests skip it.
    // Anything else (bad request, auth error) is not about the exit IP and
    // falls through to the account-level logic unchanged.
    const poolFailover = credentials._poolFailover || null;
    const poolWorthyFailure = result.status === 429 || result.status >= 500 || !result.status;
    if (poolFailover?.enabled && poolWorthyFailure) {
      failoverState.attempted.add(poolFailover.key);
      if (result.status === 429 && !failoverState.bestError) {
        failoverState.bestError = {
          status: result.status,
          error: result.error,
          headers: upstreamResponseHeaders(result.response?.headers),
        };
      }
      noteProxyPoolFailure(poolFailover.key, result.status, result.error, poolRetryAfterMs(result), model);
      if (failoverState.attempted.size < poolFailover.chainLength) {
        const nextEntry = (poolPlan?.chain || []).find((candidate) => !failoverState.attempted.has(candidate.key));
        log.warn("FALLBACK", `⇄ POOL:"${poolFailover.label || poolFailover.key}" UNAVAILABLE (${result.status}) → NEXT POOL${nextEntry ? ` "${nextEntry.label}"` : ""}`);
        lastError = result.error;
        lastStatus = result.status;
        lastHeaders = upstreamResponseHeaders(result.response?.headers);
        continue;
      }
    }

    // Chain exhausted for a no-auth provider: a dead pool must not hide the
    // rate limit that started the failover. Hand back the 429 (with its reset
    // hint) instead of the transport error from the dead entry.
    if (
      poolFailover?.enabled &&
      credentials.id === "noauth" &&
      failoverState.bestError &&
      (result.status >= 500 || !result.status)
    ) {
      return errorResponse(
        failoverState.bestError.status,
        failoverState.bestError.error,
        failoverState.bestError.headers
      );
    }

    const resetsAtMs = result.resetsAtMs;
    const shouldFallback = (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      continue;
    }

    return result.response;
  }
}
