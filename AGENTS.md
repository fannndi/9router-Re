# AGENTS.md — working in this repo

Lean fork of [decolua/9router](https://github.com/decolua/9router). One job: serve
**OpenCode Free** models through a **429 → proxy-pool failover** — one model per request —
from `127.0.0.1:20128`, for the OpenCode CLI on this machine. `README.md` has the user-facing
story; `LEAN.md` has the keep/remove matrix and the rebase recipe.

## Prime rule: removals are scripted

Never delete upstream code by hand. Add/extend a **phase in `scripts/lean.mjs`** and run it:

```bash
node scripts/lean.mjs list
node scripts/lean.mjs apply <phase>     # idempotent
node scripts/lean.mjs verify all        # every phase fully applied?
node scripts/lean.mjs audit             # rule sanity (check ⊂ find)
```

- Small edits → `find`/`replace` rules (plain text; `checkAbsent: true` for pure deletions).
- Files the fork owns outright → put the full file under `scripts/lean/overlays/` and add an
  `{ file, overlay }` rule (used for the provider pages/routes rewritten by the `sweep` phase).
- New provider support means editing the `providers` phase keep-lists, not hand-restoring files.

## Commands

```bash
npm run build            # next build --webpack (+ copies the standalone tree)
PORT=20128 node custom-server.js --port 20128   # run the production server directly
npm run dev              # dev server on :20127
(cd tests && npx vitest run)                    # unit + translator suites
npx eslint <file>        # parser/lint check
systemctl --user restart 9router                # this machine: workdir .next/standalone
```

On this machine Node is not on `PATH`: prefix commands with
`export PATH="$HOME/opt/node-v24.9.0-linux-x64/bin:$PATH"`.

## Layout

- `src/app/api/v1/*` + `src/app/api/v1beta/*` — client-facing API (OpenAI, Claude,
  Responses, Gemini, Ollama-compat).
- `src/app/(dashboard)/*` — dashboard pages (Endpoint & Key, Providers, Proxy Pools,
  Console Log, Usage, Settings).
- `src/sse/handlers/chat.js` — chat entry: single-model resolution + the **pool chain loop**.
  It builds one `buildPoolPlan()` per request and walks the chain on 429/5xx/transport
  failures (`failoverState.attempted`, `poolRetryAfterMs`).
- `src/lib/network/connectionProxy.js` — pool resolution, ordered chains
  (`buildPoolPlan`, `getOrderedActivePools`, `pickChainEntry`), per-pool+model cooldowns.
- `src/app/api/proxy-pools/[id]/diagnose/route.js` — "Check setup" checklist (read-only,
  no sudo: `ip rule`/`ip addr`, `/sys/class/net`, proxy probe, direct-vs-proxy exit IP,
  local proxy service). `scripts/ensure-pool.mjs` upserts a pool straight into `data.sqlite`
  (used by `mobile-pool/setup.sh`).
- `src/lib/usageStats.js` + `src/app/api/usage-stats/route.js` — fork-owned usage stats: one
  row per upstream call in `usageHistory` (tokens + serving pool; fail rows carry a reason),
  read by the **Usage** page (`/dashboard/pool-usage`). Hooks: `saveUsageStats()`
  (requestDetail, token rows) and the chat loop's `!result.success` branch.
- `open-sse/providers/capabilities.js` — capability/limit tables. Zen free-tier limits are
  pinned here (`zen-caps` phase) because the generic patterns mis-size them; `/v1/models`
  publishes them through the per-provider loop (the synthetic no-auth connections count as
  connections). Upstream-owned model lists (registry `modelsFetcher`) are read live through
  `src/lib/modelCatalog/liveModels.js` — cached, unioned with the models.dev copy — and feed
  `/v1/models`, `/api/models` and the daily sync.
- `open-sse/` — the SSE engine; see `open-sse/AGENTS.md`.
- `open-sse/providers/registry/opencode.js` — the only provider entry.
- `tests/` — vitest; see `tests/README.md` and `tests/translator/AGENTS.md`.

## Constraints

- One provider only (**OpenCode Free**, no-auth). No OAuth flows, no media endpoints, no
  upstream usage/quota stack (the fork's own minimal recorder is `src/lib/usageStats.js`,
  added by the `pool-usage` phase), no token savers, no tunnel/MITM, no i18n layer. Don't
  reintroduce them incidentally.
- `fetch` is monkey-patched in `open-sse/utils/proxyFetch.js` (pool + failover). Code that
  bypasses `fetch` bypasses the mobile-pool failover — use `fetch`.
- Log-line contract (Console Log reads these; keep names, not UUIDs):
  `▶ … POOL:"<pool>" (i/N)` · `[PROXY] … pool="<name>" (<id8>) | url=…` ·
  `⇄ POOL:"<a>" UNAVAILABLE (<status>) → NEXT POOL "<b>"` ·
  `✔ POOL:"<b>" served the request after N failed attempt(s)`.
- Docs are English. Keep `LEAN.md` in sync when a phase changes.
- After any engine change run: `audit` → `verify all` → `npm run build` → `vitest` → restart
  the service → smoke test `/v1/models` and a chat request.
