# 9router-Re — lean fork for the OpenCode Free gateway

A slimmed-down fork of [9router](https://github.com/decolua/9router) that serves **only
OpenCode Free** models, with two additions that matter for free-tier use:

1. **Proxy-pool failover** — when the home IP answers `429`, the same request is retried
   through the next pool entry (e.g. the phone's mobile IP via USB tether + tinyproxy),
   with per-model cooldowns that honour `Retry-After`.
2. **Combos** — round-robin/fallback across free models, so one model's limit doesn't end
   the session.

Everything else (CLI tools, media providers, usage/quota tracking, token savers, MITM,
tunnel/Tailscale, OIDC/SAML, the npm updater, 137 other providers) was removed. See
[LEAN.md](./LEAN.md) for the full keep/remove list and the re-strip recipe.

## Layout

| Path | What |
|---|---|
| `src/` | Next.js app (dashboard + `/api/*`, `/v1/*` endpoints) |
| `open-sse/` | Provider-agnostic SSE engine (translator, executors, registry) |
| `scripts/lean.mjs` | The strip script: `list` / `apply <phase>` / `verify` |
| `mobile-pool/` | Two-IP setup (tether + tinyproxy + policy routing) and helpers |

## Run locally

```bash
npm install
npm run build
PORT=20128 node custom-server.js        # or the systemd unit below
```

Systemd user service (used on this machine):

```ini
# ~/.config/systemd/user/9router.service
[Service]
WorkingDirectory=%h/Gateway/9router/.next/standalone
Environment=PORT=20128
ExecStart=%h/opt/node-v24.9.0-linux-x64/bin/node custom-server.js
Restart=always
```

`systemctl --user enable --now 9router && loginctl enable-linger $USER`

## Client config (OpenCode)

Copy `mobile-pool/opencode.jsonc` into a workspace and replace the API key placeholder with
a key from **Endpoint & Key** in the dashboard. It exposes the free models plus the
`free-autopilot` combo and points at `http://127.0.0.1:20128/v1`.

## Keeping up with upstream

```bash
git fetch upstream
git rebase upstream/master
node scripts/lean.mjs verify all && node scripts/lean.mjs apply all
npm install && npm run build && systemctl --user restart 9router
```

The strip script is idempotent and fails loudly when upstream moved a patch site, so a
rebase never leaves a half-stripped tree. Fingerprint changes for the OpenCode free tier
(they happen) arrive through `git rebase` like everything else.
