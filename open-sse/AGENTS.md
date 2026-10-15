# open-sse (lean fork)

Provider-agnostic SSE engine: one client request → OpenCode Free, streamed back in the
client's own format. The fork is scripted in `scripts/lean.mjs` (see `LEAN.md`); every phase
is idempotent.

## Request lifecycle (chat)

`handlers/chatCore.js` → `services/model.js` `parseModel` (resolve `provider/model`) →
`translator/index.js` `translateRequest` (client format → provider format) →
`executors/index.js` `getExecutor(provider)` (`opencode` executor; everything else falls back
to `DefaultExecutor`) → `executor.execute()` (streams upstream) → `translateResponse` → SSE
out.

## Directory map

- `config/` — `providers.js` (registry view), `providerModels.js` (alias→models helpers +
  OpenCode family fallbacks), `runtimeConfig.js` (timeouts, limits), `appConstants.js`
  (client-spoof constants incl. `CLAUDE_SYSTEM_PROMPT`), `errorConfig.js`, `awsConstants.js`
  removed; `models.js`/`constants.js` barrels removed.
- `translator/` — format conversion. Kept pairs (the only ones reachable):
  `request/claude-to-openai`, `request/gemini-to-openai`, `request/openai-to-claude`,
  `request/openai-responses`, `response/claude-to-openai`, `response/openai-to-claude`,
  `response/openai-responses`. `index.js` is the registry; translators self-register through
  the static imports at the bottom of that file.
- `executors/` — `opencode.js` (Zen free transport: fingerprint, reasoning echo, session id,
  `responses`/`claude` lanes for muse-spark/union-alpha) + `default.js` (generic
  OpenAI/Anthropic-compatible endpoints) + `base.js`.
- `providers/` — `registry/index.js` (single entry: `opencode.js`), `capabilities.js`,
  `pricing.js`, `shared.js`, `visionPatterns.js`, `thinkingLevels.js`, `models/` (helpers +
  schema for alias/family resolution).
- `handlers/` — `chatCore.js` + `chatCore/` (streaming / non-streaming / sse-to-json) and
  `chatCore/requestDetail.js` (log-only). `chatCore.js` also renders the pool label on the
  request line (`POOL:"<name>" (i/N)`) and the pool name in the `[PROXY]` line; both come from
  `credentials._poolFailover` / `providerSpecificData.connectionProxyPoolName` (set by the chat
  handler — open-sse must not read the DB). Media cores and `responsesHandler.js` removed.
- `services/` — `model.js`, `provider.js`, `combo.js` (fallback / round-robin / fusion),
  `capacityAdapter.js` (**vision pool only**), `accountFallback.js`, `tokenRefresh*`
  (API shape kept; no OAuth providers remain), `oauthCredentialManager.js`.
- `utils/` — `streamHandler`, `stream`, `streamHelpers`, `error`, `sessionManager`,
  `claudeCloaking`, `claudeSignature`, `clientDetector`, `proxyFetch` (global fetch patch +
  proxy pools), `opencodeFingerprint`, `reasoningContentInjector`, `toolDeduper`,
  `ollamaTransform`, `upstreamHeaders`, `modelMarkers`, `bypassHandler`.

## Conventions

- Config-driven, DRY, camelCase. No hardcoded values, models or block/role strings — use
  `config/` + `schema/` constants.
- The translator pipeline pivots through OpenAI as the intermediate format; a translator
  registered on the exact `source:target` pair runs as a direct route.
- New translator files MUST be imported at the bottom of `translator/index.js` (and in
  `tests/translator/registerAll.js`).

## How to add

- **Provider**: copy `providers/registry/opencode.js` as the shape reference, add
  `providers/registry/{id}.js`, import it in `providers/registry/index.js`, and add its id to
  the `providers` phase keep-list in `scripts/lean.mjs`.
- **Executor** (only for non-standard upstreams): subclass `BaseExecutor`
  (`getBaseUrls`/`buildHeaders`/`buildUrl`/`execute`) and register it in the `executors` map in
  `executors/index.js`. `getExecutor` falls back to `DefaultExecutor`.
- **Translator**: add `request|response/<from>-to-<to>.js` calling `register(...)`, import it
  in `translator/index.js`, re-run `node scripts/lean.mjs verify sweep` (the sweep only prunes
  the provider-only pairs).

## Pitfalls

- The OpenAI bridge is lossy (thinking, non-base64 images, tool ids, `is_error`) — prefer a
  direct route for fragile pairs.
- `providers/registry/index.js` upstream is auto-generated; here it is hand-maintained and
  script-filtered. Keep the default export an array of registry entries.
- `fetch` is patched globally by `utils/proxyFetch.js` (proxy pools / failover). Anything
  bypassing it bypasses the mobile-pool failover.
