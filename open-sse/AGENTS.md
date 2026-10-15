# open-sse (lean fork)

Provider-agnostic SSE engine: one OpenAI-style request → OpenCode Free, streamed back in
the client's format. This fork stripped the engine down to a single provider; the strip is
scripted in `scripts/lean.mjs` (see `LEAN.md`) and every phase is idempotent.

## Request lifecycle (chat)

`handlers/chatCore.js` → `services/model.js` `parseModel` (resolve `provider/model`) →
`translator/index.js` `translateRequest` (client format → provider format) →
`executors/index.js` `getExecutor(provider)` (`opencode` executor; everything else falls
back to `DefaultExecutor`) → `executor.execute()` (streams upstream) → `translateResponse`
→ SSE out.

## Directory map

- `config/` — constants/config. `providers.js` (barrel), `providerModels.js` (alias→models),
  `runtimeConfig.js` (timeouts, token limits), `*Constants.js`.
- `translator/` — format conversion (`request/<from>-to-<to>.js`, `response/…`, `schema/`,
  `concerns/`, `formats.js`). `index.js` is the registry/entry; translators self-register on
  import.
- `executors/` — only `opencode.js` (Zen free transport: fingerprint, reasoning echo,
  session id) + `default.js` (generic OpenAI/Anthropic-compatible) + `base.js`.
- `providers/` — `registry/index.js` (single entry: `opencode.js`), `capabilities.js`,
  `pricing.js`, `shared.js`, `visionPatterns.js`, `thinkingLevels.js`.
- `handlers/` — `chatCore.js` + `chatCore/` (streaming / non-streaming / sse-to-json) and
  `responsesHandler.js`. Media cores (image/tts/stt/video/embedding/search) were removed.
- `services/` — `model.js`, `provider.js`, `accountFallback.js`, `combo.js` (fallback /
  round-robin / fusion), `capacityAdapter.js` (**vision pool only**), `tokenRefresh*`
  (kept for API shape; no OAuth providers remain), `projectId.js`, `thoughtSignatureStore.js`.
- `utils/` — `streamHandler`, `stream`, `sse`, `error`, `sessionManager`, `claudeCloaking`,
  `clientDetector`, `proxyFetch` (global fetch patch + proxy pools), `opencodeFingerprint`,
  `reasoningContentInjector`, `ollamaTransform`.

## Conventions

- Config-driven, DRY, camelCase. Never hardcode values, models, or block/role strings — use
  `config/` + `schema/` constants.
- The translator pipeline pivots through OpenAI as the intermediate format. A translator
  registered on the exact `source:target` pair runs as a direct route.
- Translators self-register via `register(from, to, reqFn, resFn)` as an import side-effect;
  new files MUST be imported in `translator/index.js`.

## How to add

- **Provider**: copy `providers/REGISTRY_TEMPLATE.js` → `providers/registry/{id}.js`, add it
  to `providers/registry/index.js` (single static import list), and add models there. If you
  want it kept after a re-strip, also add it to the `providers` phase keep-list in
  `scripts/lean.mjs`.
- **Executor** (only for non-standard upstream): subclass `BaseExecutor` (override
  `getBaseUrls`/`buildHeaders`/`buildUrl`/`execute`), register it in the `executors` map in
  `executors/index.js`. `getExecutor` falls back to `DefaultExecutor` when absent.
- **Translator**: add `request|response/<from>-to-<to>.js` calling `register(...)`, then
  import it in `translator/index.js`. Reuse `schema/` + `concerns/`.

## Pitfalls

- OpenAI bridge is lossy (thinking, non-base64 images, tool ids, is_error) — prefer a direct
  route for fragile pairs.
- `providers/registry/index.js` upstream is auto-generated; here it is hand-maintained and
  script-filtered. Keep the default export an array of registry entries.
- `fetch` is patched globally by `utils/proxyFetch.js` (proxy pools / failover). Anything
  that bypasses it bypasses the mobile-pool failover.
