# AGENTS.md — working in this repo

Lean fork of [decolua/9router](https://github.com/decolua/9router). One job: serve
**OpenCode Free** models through a **429 → proxy-pool failover** with **combos**, from
`127.0.0.1:20128`, for the OpenCode CLI on this machine. `README.md` has the user-facing
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
- `src/app/(dashboard)/*` — dashboard pages (Endpoint & Key, Providers, Combos, Proxy Pools,
  Console Log, Settings).
- `src/sse/handlers/chat.js` — chat entry: combo iteration + the **pool chain loop**.
  It builds one `buildPoolPlan()` per request and walks the chain on 429/5xx/transport
  failures (`failoverState.attempted`, `poolRetryAfterMs`).
- `src/lib/network/connectionProxy.js` — pool resolution, ordered chains
  (`buildPoolPlan`, `getOrderedActivePools`, `pickChainEntry`), per-pool+model cooldowns.
- `src/app/api/proxy-pools/[id]/diagnose/route.js` — "Check setup" checklist (read-only,
  no sudo: `ip rule`/`ip addr`, `/sys/class/net`, proxy probe, direct-vs-proxy exit IP,
  local proxy service). `scripts/ensure-pool.mjs` upserts a pool straight into `data.sqlite`
  (used by `mobile-pool/setup.sh`).
- `open-sse/` — the SSE engine; see `open-sse/AGENTS.md`.
- `open-sse/providers/registry/opencode.js` — the only provider entry.
- `tests/` — vitest; see `tests/README.md` and `tests/translator/AGENTS.md`.

## Constraints

- One provider only (**OpenCode Free**, no-auth). No OAuth flows, no media endpoints, no
  usage persistence, no token savers, no tunnel/MITM, no i18n layer. Don't reintroduce them
  incidentally.
- `fetch` is monkey-patched in `open-sse/utils/proxyFetch.js` (pool + failover). Code that
  bypasses `fetch` bypasses the mobile-pool failover — use `fetch`.
- Log-line contract (Console Log reads these; keep names, not UUIDs):
  `▶ … POOL:"<pool>" (i/N)` · `[PROXY] … pool="<name>" (<id8>) | url=…` ·
  `⇄ POOL:"<a>" UNAVAILABLE (<status>) → NEXT POOL "<b>"` ·
  `✔ POOL:"<b>" served the request after N failed attempt(s)`.
- Docs are English. Keep `LEAN.md` in sync when a phase changes.
- After any engine change run: `audit` → `verify all` → `npm run build` → `vitest` → restart
  the service → smoke test `/v1/models` and a combo chat.
