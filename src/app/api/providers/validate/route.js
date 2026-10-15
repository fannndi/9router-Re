import { NextResponse } from "next/server";
import { getProviderNodeById } from "@/models";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isCustomEmbeddingProvider, AI_PROVIDERS } from "@/shared/constants/providers";
import { getDefaultModel } from "open-sse/config/providerModels.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import { normalizeProviderId } from "@/lib/providerNormalization";

// POST /api/providers/validate - Validate API key with provider
//
// Lean fork: only custom OpenAI/Anthropic-compatible nodes and the no-auth
// OpenCode Free provider can be validated, so the upstream provider switch is
// gone. Compatible nodes are probed through their own endpoints; everything
// else falls back to the config-driven probe below.
export async function POST(request) {
  try {
    const body = await request.json();
    const provider = normalizeProviderId(body.provider);
    const { apiKey, providerSpecificData } = body;

    const isNoAuth = AI_PROVIDERS[provider]?.noAuth === true;
    const apiKeySubstitute = AI_PROVIDERS[provider]?.apiKeyOptionalWith;
    const hasApiKeySubstitute = !!(apiKeySubstitute && providerSpecificData?.[apiKeySubstitute]);
    if (!provider || (!apiKey && !isNoAuth && !hasApiKeySubstitute)) {
      return NextResponse.json({ error: "Provider and API key required" }, { status: 400 });
    }

    let isValid = false;
    let error = null;

    try {
      if (isOpenAICompatibleProvider(provider)) {
        const node = await getProviderNodeById(provider);
        if (!node) {
          return NextResponse.json({ error: "OpenAI Compatible node not found" }, { status: 404 });
        }
        const modelsUrl = `${node.baseUrl?.replace(/\/$/, "")}/models`;
        const res = await fetch(modelsUrl, {
          headers: { "Authorization": `Bearer ${apiKey}` },
        });
        isValid = res.ok;
        return NextResponse.json({
          valid: isValid,
          error: isValid ? null : "Invalid API key",
        });
      }

      // Custom Embedding nodes: probe /models (most embedding APIs are OpenAI-compatible)
      if (isCustomEmbeddingProvider(provider)) {
        const node = await getProviderNodeById(provider);
        if (!node) {
          return NextResponse.json({ error: "Custom Embedding node not found" }, { status: 404 });
        }
        const baseUrl = node.baseUrl?.replace(/\/$/, "");
        const modelsRes = await fetch(`${baseUrl}/models`, {
          headers: { "Authorization": `Bearer ${apiKey}` },
        });
        if (modelsRes.ok) {
          return NextResponse.json({ valid: true });
        }
        // Auth errors are definitive
        if (modelsRes.status === 401 || modelsRes.status === 403) {
          return NextResponse.json({ valid: false, error: "Invalid API key" });
        }
        // Fallback: probe /embeddings with a common test model — many providers lack /models
        const embedRes = await fetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "test", input: "ping" }),
        });
        // 401/403 = bad key; anything else (including 400 "model not found") means key works
        isValid = embedRes.status !== 401 && embedRes.status !== 403;
        return NextResponse.json({
          valid: isValid,
          error: isValid ? null : "Invalid API key",
        });
      }

      if (isAnthropicCompatibleProvider(provider)) {
        const node = await getProviderNodeById(provider);
        if (!node) {
          return NextResponse.json({ error: "Anthropic Compatible node not found" }, { status: 404 });
        }

        let normalizedBase = node.baseUrl?.trim().replace(/\/$/, "") || "";
        if (normalizedBase.endsWith("/messages")) {
          normalizedBase = normalizedBase.slice(0, -9); // remove /messages
        }

        const messagesUrl = `${normalizedBase}/v1/messages`;
        const model = node.defaultModel || "claude-3-haiku-20240307";

        const res = await fetch(messagesUrl, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: "user", content: "test" }],
          }),
        });

        // 400/529 still confirms key accepted; only 401/403 = bad key
        isValid = res.status !== 401 && res.status !== 403;
        return NextResponse.json({
          valid: isValid,
          error: isValid ? null : "Invalid API key",
        });
      }

      // Config-driven probe for registry providers (OpenCode Free is no-auth).
      const cfg = PROVIDERS[provider];
      if (!cfg || cfg.format !== "openai" || !cfg.baseUrl) {
        return NextResponse.json({ error: "Provider validation not supported" }, { status: 400 });
      }
      if (cfg.noAuth) {
        return NextResponse.json({ valid: true, error: null });
      }
      const headers = { "Content-Type": "application/json", ...(cfg.headers || {}) };
      if (cfg.authHeader === "x-api-key") headers["X-API-Key"] = apiKey;
      else headers["Authorization"] = `Bearer ${apiKey}`;
      // Try /models first (fast GET), fallback to chat probe on ambiguous response
      const modelsUrl = cfg.baseUrl.replace(/\/chat\/completions$/, "/models").replace(/\/chatbot$/, "/models");
      let probeOk = null;
      try {
        const probeRes = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(8000) });
        if (probeRes.status === 401 || probeRes.status === 403) probeOk = false;
        else if (probeRes.ok) probeOk = true;
      } catch { /* fallback to chat */ }
      if (probeOk !== null) {
        isValid = probeOk;
      } else {
        // Fallback: minimal chat probe
        const defaultModel = getDefaultModel(provider) || "test";
        const chatRes = await fetch(cfg.baseUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: defaultModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
          signal: AbortSignal.timeout(10000),
        });
        isValid = chatRes.status !== 401 && chatRes.status !== 403;
      }
    } catch (err) {
      error = err.message;
      isValid = false;
    }

    return NextResponse.json({
      valid: isValid,
      error: isValid ? null : (error || "Invalid API key"),
    });
  } catch (error) {
    console.log("Error validating API key:", error);
    return NextResponse.json({ error: "Validation failed" }, { status: 500 });
  }
}
