# 9router-Re — lean fork of 9Router for the OpenCode Free gateway

A slimmed-down fork of [decolua/9router](https://github.com/decolua/9router) that serves
**only OpenCode Free** models, with two additions that matter for free-tier use:

1. **Proxy-pool failover on 429** — when the home IP is rate-limited, the same request is
   retried through the next pool entry (the phone's mobile IP over USB tether + tinyproxy),
   with per-model cooldowns that honour `Retry-After`.
2. **Combos** — round-robin / fallback across free models so one model's limit does not end
   the session.

Everything else from upstream is gone: 137 other providers, media endpoints, usage/quota
tracking, token savers, MITM, Cloudflare tunnel/Tailscale, OIDC/SAML, the npm updater, the
CLI-tool config writers, serverless relay deploys and the dashboard i18n layer. The strip is
scripted (`scripts/lean.mjs`) so `git rebase upstream/master` stays cheap — see
[LEAN.md](./LEAN.md).

## What it does

```
OpenCode CLI / any OpenAI-compatible client
        │  POST /v1/chat/completions   (or /v1/messages, /v1/responses, /v1beta, /v1/api/chat)
        ▼
  9Router  ── combo picks model ──► OpenCode Free upstream
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
| Combos (round-robin / fallback / fusion) + vision adapter | `open-sse/services/combo.js`, `open-sse/services/capacityAdapter.js` |
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
key from **Endpoint & Key**. `free-autopilot` is the combo (round-robin across the free
models); the individual `oc/*` models are also listed.

```jsonc
{
  "provider": {
    "9router": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:20128/v1", "apiKey": "<key from Endpoint & Key>" },
      "models": { "free-autopilot": { "name": "Free Autopilot (combo)" } }
    }
  },
  "model": "9router/free-autopilot"
}
```

## Dashboard tour

| Page | What |
|---|---|
| **Endpoint & Key** | the API base URL + key management (`require API key`, restrictions) |
| **Providers** | OpenCode Free status + custom OpenAI/Anthropic-compatible endpoints |
| **Combos** | `free-autopilot` membership, strategy (fallback / round-robin / fusion) and the vision adapter |
| **Provider strategy** (Providers → OpenCode Free) | `Failover on 429` (direct → pools, walks the ordered chain) or `Round-robin`/`Random` (start pool alternates per request, a failed pool falls through to the next). Mobile pools consume phone quota — round-robin is a demo mode; keep failover for daily use. |
| **Proxy Pools** | pool entries with a **Failover order** (`Local (host)` → `127.0.0.1:8899`, `Mobile (phone tether)` → `127.0.0.1:8888`), plus the row **Check setup** button that verifies tether / policy route / proxy / exit IP without sudo |
| **Console Log** | live server output with per-request pool attribution: `▶ … POOL:"Mobile (phone tether)" (2/2)`, `[PROXY] … pool="…" | url=…`, `⇄ POOL:"direct" UNAVAILABLE (429) → NEXT POOL "…"` |
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
