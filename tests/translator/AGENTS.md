# Translation Layer Tests

Tests for `open-sse/translator/`. Goal: keep the pairs that can actually occur correct, and
expose bugs caused by using OpenAI as the intermediate format. The fork only keeps
`openai`, `claude`, `gemini`, `openai-responses` and Ollama-compat (`/v1/api/chat`) as client
formats, and OpenCode emits `openai` (+`claude` for union-alpha, `openai-responses` for
muse-spark).

## 1. Structure (`open-sse/translator/`)

Pipeline uses **OpenAI as the intermediate format**:
- Request: `source → openai → target` (`translateRequest`)
- Response (SSE chunk): `target → openai → source` (`translateResponse`)
- If `source === target` → translation is skipped (passthrough).

Registered pairs (bottom of `index.js`):

| Direction | Request file | Response file |
|---|---|---|
| claude ↔ openai | `request/claude-to-openai.js` | `response/claude-to-openai.js` |
| openai → claude (provider target) | `request/openai-to-claude.js` | `response/openai-to-claude.js` |
| gemini → openai (client only) | `request/gemini-to-openai.js` | — (the `v1beta` route builds Gemini responses inline) |
| openai ↔ openai-responses | `request/openai-responses.js` | `response/openai-responses.js` |

Components:
- `index.js` — `translateRequest` / `translateResponse` / `register(from, to, requestFn, responseFn)` / registry.
- `formats.js` — `FORMATS` enum (`openai`, `openai-responses`, `claude`, `gemini`, `gemini-cli`, `ollama`, … — provider-only formats were pruned with the `sweep` phase).
- `schema/` — pure data enums (roles, blocks, finish reasons, defaults). Import via `schema/index.js`.
- `concerns/` — cross-format logic: `chunk.js`, `usage.js`, `reasoning.js`, `thinking.js`, `thinkingUnified.js`, `toolCall.js`, `finishReason.js`, `image.js`, `json.js`, `message.js`, `modality.js`, `prefetch.js`, `claudeMessage.js`.
- `formats/` — per-format logic: `openai.js`, `claude.js`, `gemini.js`, `responsesApi.js`, `maxTokens.js`.

**OpenAI-bridge pitfalls** (source of most bugs): going through OpenAI easily loses
`thinking`/`reasoning`, image URLs (non-base64), `input_audio`, `is_error`; tool `id`/`index`
become unstable (parallel tool calls), non-text system blocks, `tool_choice:"none"`.

## 2. Test layout

| File | Role |
|---|---|
| `matrix.js` | Reads `PROVIDER_MODELS` → builds the matrix (alias, model, targetFormat, strip, upstreamId). DRY core. |
| `registerAll.js` | Imports the kept translators to run `register()` side-effects. **Required** (see §5). |
| `coverage-all-models.test.js` | Tier 1: every model translates without throwing; strip applied correctly. |
| `format-roundtrip.test.js` | Tier 2: tool id/system/parallel survive the bridge. |
| `golden-*.test.js` | Locked request/response shapes per kept pair. |
| `records` in `__snapshots__/` | Snapshots for the golden suites — update with `npx vitest run -u` after intentional shape changes. |
| `real/` | Live-provider suites; skipped unless `RUN_REAL=1`. |

## 3. Running

Run from `tests/` so `vitest.config.js` (aliases) applies:

```bash
cd tests
npx vitest run translator/                 # offline
RUN_REAL=1 npx vitest run translator/real/ # against the local deployment
```

No-cred tests make NO network calls. Real tests read active connections from
`~/.9router/db/data.sqlite`, send a tiny prompt per provider through `handleChatCore`, and
assert a valid SSE stream. Account/quota errors (401/402/403/429) are treated as credential
issues and skipped, not failures.

## 4. Adding a provider → tests cover it AUTOMATICALLY

Add the provider to `open-sse/providers/registry/index.js` (one entry per provider; models
carry `targetFormat`/`strip`/`upstreamModelId`).
→ `coverage-all-models.test.js` runs for the new models with **no test edits** (`matrix.js`
reads the registry directly).

Only add a dedicated test when the provider has a special format that does not round-trip
cleanly.

## 5. `registerAll.js` — why it is required

`translator/index.js` imports translators as side effects; under vitest/ESM any import that
silently no-ops leaves the registry empty → `translateRequest` skips translation → **false
pass**. Every test calling `translateRequest`/`translateResponse` must
`import "./registerAll.js"` at the top.

## 6. Bug-exposure convention — `it.fails`

- A bug confirmed in the app but NOT yet fixed → `it.fails(...)`.
- `it.fails` **passes while the app still has the bug**, **turns red once fixed** → switch it
  to `it` and confirm correct behavior.
- Pattern: real input → assert the "should-be-kept" behavior → `it.fails` + a comment with
  the source `file:line`.
