# 9router-Re — lean fork of 9Router for the OpenCode Free gateway

A slimmed-down fork of [decolua/9router](https://github.com/decolua/9router) that serves
**only OpenCode Free** models, with two additions that matter for free-tier use:

1. **Two exit IPs, spread on purpose** — `round-robin` alternates requests between the home
   connection and the phone's mobile IP (USB tether + tinyproxy), so every IP carries its own
   share of the free-tier limits and sessions last longer. A rate-limited pool falls through
   to the next one *inside the same request*, with per-model cooldowns that honour
   `Retry-After`. `Failover on 429` keeps the phone idle until a 429 (quota-saver variant).
2. **One model per request, chosen by you** — no model rotation layered on top of the pool
   rotation, so the output quality stays predictable. The pools below still spread every
   model's traffic across both IPs.
3. **Usage page** — what the pools actually did: donut with `Pool Local` / `Pool Mobile` /
   `Fail` percentages, token totals (input / cached / output — **no dollars**), per-model
   fail rate + reasons, and the latest requests with the pool that carried them
   (`/dashboard/pool-usage`).

Everything else from upstream is gone: 137 other providers, media endpoints, the upstream
usage/quota stack (the fork ships its own minimal Usage page instead), token savers, MITM,
Cloudflare tunnel/Tailscale, OIDC/SAML, the npm updater, the CLI-tool config writers,
serverless relay deploys and the dashboard i18n layer. The strip is
scripted (`scripts/lean.mjs`) so `git rebase upstream/master` stays cheap — see
[LEAN.md](./LEAN.md).

## What it does

```
OpenCode CLI / any OpenAI-compatible client
        │  POST /v1/chat/completions   (or /v1/messages, /v1/responses, /v1beta, /v1/api/chat)
        ▼
  9Router  ── single model (picked by you) ──► OpenCode Free upstream
        │        │
        │        └─ 429 / 5xx → retry same model through the next proxy-pool entry
        ▼                           (direct → mobile pool, per-model cooldown)
     streamed back in the client's own format
```

Kept surface:

| Area | Where |
|---|---|
| OpenAI-compatible API (`/v1/chat/completions`, `/v1/models`, `/v1/messages`, `/v1/responses`, `/v1beta/...`, Ollama `/v1/api/chat` + `/api/tags`) | `src/app/api/v1/*` |
| OpenCode Free provider (no-auth, fingerprint headers, reasoning echo, `targetFormat` per model) | `open-sse/providers/registry/opencode.js`, `open-sse/executors/opencode.js` |
| 429 failover through proxy pools (direct first, per-model cooldown) | `src/lib/network/connectionProxy.js`, `src/sse/services/auth.js`, `src/sse/handlers/chat.js` |
| Custom OpenAI/Anthropic-compatible endpoints (provider nodes) | `/dashboard/providers/new`, `open-sse/executors/default.js` |
| API keys, dashboard password login, console log | `/dashboard/endpoint`, `/dashboard/console-log` |

## Requirements

- Node **≥ 22.5** (uses `node:sqlite`; `better-sqlite3` is an optional faster driver)
- No system packages beyond that. The dashboard and API bind to `127.0.0.1:20128`.

## Run it

```bash
npm install
npm run build                     # next build --webpack + standalone asset copy
PORT=20128 node custom-server.js  # production server (.next/standalone internally)
```

Development:

```bash
npm run dev                       # http://localhost:20127
```

### systemd (what this machine uses)

```ini
# ~/.config/systemd/user/9router.service
[Unit]
Description=9Router gateway (LAN + mobile pool)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/Gateway/9router/.next/standalone
Environment=PORT=20128
Environment=HOSTNAME=127.0.0.1
Environment=NODE_ENV=production
Environment=PATH=%h/opt/node-v24.9.0-linux-x64/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/opt/node-v24.9.0-linux-x64/bin/node custom-server.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now 9router
loginctl enable-linger $USER     # keep running without an open session
```

Default dashboard password is `123456` (set via `INITIAL_PASSWORD` on first boot, change it
in **Settings**).

## Client config (OpenCode)

Copy `../mobile-pool/opencode.jsonc` into a workspace and replace the key placeholder with a
key from **Endpoint & Key**. Every free `oc/*` model the gateway serves is listed. Each entry
pins its real window via `limit: { context, output }` (Zen free-tier values) because OpenCode
falls back to its own `200k/32k` default for models that omit it. The list mirrors the
gateway's live `/v1/models` — retired ids disappear, new Zen free models appear — and can be
re-synced any time with `node ../mobile-pool/refresh-opencode-models.mjs`.

```jsonc
{
  "providers": {
    "9router": {
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:20128/v1", "apiKey": "<key from Endpoint & Key>" },
      "models": { "oc-step-5-preview-free": { "name": "Step 5 (free)" } }
    }
  }
}
```

## Dashboard tour

| Page | What |
|---|---|
| **Endpoint & Key** | the API base URL + key management (`require API key`, restrictions) |
| **Providers** | OpenCode Free status + custom OpenAI/Anthropic-compatible endpoints |
| **Provider strategy** (Providers → OpenCode Free) | `Round-robin` (default here): the start pool alternates on every upstream call, a rate-limited pool falls through to the next, so both IPs share the free limits. `Failover on 429`: direct first, pools only on 429 (phone data stays idle until needed). `Random`: same as round-robin with a random start. |
| **Proxy Pools** | pool entries with a **Failover order** (`Local (host)` → `127.0.0.1:8899`, `Mobile (phone tether)` → `127.0.0.1:8888`), plus the row **Check setup** button that verifies tether / policy route / proxy / exit IP without sudo |
| **Console Log** | live server output with per-request pool attribution: `▶ … POOL:"Mobile (phone tether)" (2/2)`, `[PROXY] … pool="…" | url=…`, `⇄ POOL:"direct" UNAVAILABLE (429) → NEXT POOL "…"` |
| **Usage** | attempt-level stats with **pool attribution** (one row per upstream call, incl. pool retries): donut `Pool Local` / `Pool Mobile` / `Fail` in %, totals (requests · input · cached · output tokens, no dollars), per-model fail rate + fail reasons, latest requests with their pool. Ranges: Today / 24h / 7D / 30D / 60D; data is pruned after 90 days. |
| **Settings** | password/login, routing strategy, outbound proxy, observability toggle, backup |

## Environment

Only the variables the code actually reads (see `.env.example`):

| Variable | Purpose |
|---|---|
| `PORT` | listen port (default 20128; dashboard 20127 in dev) |
| `HOSTNAME` | bind address (the systemd unit pins `127.0.0.1`) |
| `JWT_SECRET` | signs the dashboard session cookie |
| `INITIAL_PASSWORD` | first-boot dashboard password (`123456` by default) |
| `API_KEY_SECRET` | secret used when hashing API keys |
| `MACHINE_ID_SALT` | salt for the CLI-token machine id |
| `DATA_DIR` | where `data.sqlite` lives (default `~/.9router/db`) |
| `STRICT_SSL` | `true` disables the TLS-relaxed fetch fallback |
| `TRUST_PROXY` | honour `X-Forwarded-*` when behind a reverse proxy |
| `ENABLE_REQUEST_LOGS` / `LOG_LEVEL` | file logging / log verbosity |
| `MODEL_CATALOG_SYNC` | daily models.dev catalog sync (on by default) |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` | outbound proxy for upstream calls |

## Keeping up with upstream

```bash
git fetch upstream
git rebase upstream/master
node scripts/lean.mjs verify all        # any phase half-applied after the rebase?
node scripts/lean.mjs apply all         # idempotent; fails loudly when a patch site moved
node scripts/lean.mjs audit             # rule-sanity check (check ⊂ find detection)
npm install && npm run build
npx vitest run                          # from tests/
systemctl --user restart 9router
```

OpenCode Free fingerprint changes arrive through the rebase like everything else.

## Layout

| Path | What |
|---|---|
| `src/` | Next.js app — dashboard pages + `/api/*` + client-facing `/v1/*` routes |
| `open-sse/` | provider-agnostic SSE engine (translator, executors, registry, handlers) |
| `scripts/lean.mjs` | the strip tool: `list` / `apply <phase>` / `verify` / `audit` |
| `scripts/lean/overlays/` | full-file replacements for fork-owned files (see LEAN.md) |
| `tests/` | vitest suites (`unit/`, `translator/`) |
| `../mobile-pool/` | two-IP setup for this machine (tether + tinyproxy + policy routing) |

MIT — see [LICENSE](./LICENSE). Upstream: [decolua/9router](https://github.com/decolua/9router).
