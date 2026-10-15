# LEAN.md — what this fork keeps, and how to re-strip it

This is a **slim fork** of [decolua/9router](https://github.com/decolua/9router) for one
job: serving the **OpenCode Free** models through a **two-IP failover pool** so free-tier
rate limits survive longer, with **combos** (round-robin across models) on top.

Everything else was removed on purpose. The strip is **scripted** so upstream changes stay
cheap to absorb:

```bash
node scripts/lean.mjs list              # phases + what each one removes
node scripts/lean.mjs apply <phase>     # idempotent; safe to re-run
node scripts/lean.mjs apply all
node scripts/lean.mjs verify all        # fails if a phase is only half-applied
```

Phases: `updater`, `cli-tools`, `media`, `usage-quota`, `token-saver`, `sso`,
`mitm-tunnel`, `providers`, `cosmetics`.

## What the fork keeps

| Area | Where |
|---|---|
| OpenAI-compatible API (`/v1/chat/completions`, `/v1/models`, `/v1/messages`, `/v1/responses`, `/v1beta`) | `src/app/api/v1/*` |
| OpenCode Free provider (no-auth, fingerprint headers, reasoning echo) | `open-sse/providers/registry/opencode.js`, `open-sse/executors/opencode.js` |
| **Proxy-pool failover on 429/5xx** (direct → mobile pool, per-model cooldowns) | `src/lib/network/connectionProxy.js`, `src/sse/services/auth.js`, `src/sse/handlers/chat.js` |
| Proxy Pools dashboard + API | `/dashboard/proxy-pools`, `/api/proxy-pools/*` |
| Combos (round-robin / fallback / fusion) + **vision adapter only** | `open-sse/services/combo.js`, `open-sse/services/capacityAdapter.js` |
| API keys, provider connections, dashboard password login | `/dashboard/endpoint`, `/api/keys`, `/api/providers` |
| Console Log (live server output for debugging) | `/dashboard/console-log` |

Also kept but inert until used: provider-nodes (custom OpenAI-compatible endpoints),
model aliases/tags, `ENABLE_REQUEST_LOGS` file logging, daily models.dev catalog sync.

## What was removed (and why)

| Phase | Removed | Reason |
|---|---|---|
| `updater` | `/api/version*`, `appUpdater` | ran `npm i -g 9router` — would install **upstream** over this fork |
| `cli-tools` | 30 CLI config writers, MCP stdio bridge, combo presets | only OpenCode is used |
| `media` | image/TTS/STT/video/embedding/web-search/systemone | chat gateway; **vision input stays** |
| `usage-quota` | usage history, stats charts, quota tracker, auto-ping, per-provider quota fetchers | no paid accounts to track |
| `token-saver` | RTK, headroom, caveman, ponytail, PXPIPE | prompt compression hurt tool selection |
| `sso` | OIDC + SAML | password-only local dashboard |
| `mitm-tunnel` | MITM proxy, Cloudflare tunnel, Tailscale, watchdog/network monitor | reached over LAN + phone tether |
| `providers` | 137 provider registries, ~28 executors, all OAuth flows/services, background token refresh | keep only OpenCode Free |
| `cosmetics` | docs sites, deploy manifests, npm `cli/`, Skills, Translator, pricing page, promos, sql.js fallback | dead weight |

Notable side effects, all intentional:

- `src/lib/usageDb.js` and `open-sse/handlers/chatCore/requestDetail.js` are **stubs /
  log-only**: the chat path still calls them, nothing is persisted. The `📊 DONE … IN/OUT`
  line still prints.
- `src/shared/services/initializeApp.js` is a ~30-line service (deferred connection
  housekeeping only).
- `custom-server.js` no longer starts a token-refresh scheduler; `src/proxy.js` is just the
  dashboard auth guard.
- Provider pickers, `/v1/models` and the dashboard derive from the pruned
  `open-sse/providers/registry/index.js` (single entry: `opencode`).

## Rebase recipe (when upstream changes, e.g. a new Zen fingerprint)

```bash
cd ~/Gateway/9router
git fetch upstream
git rebase upstream/master          # your patch commits live on top
node scripts/lean.mjs verify all    # any conflict left a phase half-applied?
node scripts/lean.mjs apply all     # re-strip idempotently
npm install && npm run build
npx vitest run unit/proxy-pool-failover.test.js
systemctl --user restart 9router
```

If a phase fails with *"patch site not found"*, upstream moved that file: open
`scripts/lean.mjs`, update that one rule (find/replace strings are plain text), re-run.

## Adding a provider back

1. Restore `open-sse/providers/registry/<id>.js` (from upstream) and add its import to
   `open-sse/providers/registry/index.js`.
2. If it needs a dedicated executor, restore it and register it in
   `open-sse/executors/index.js`.
3. Remove the id from that phase's keep-list if you want the strip script to stop pruning it.

## Verification checklist

- `npm run build` → compiles, static pages generated.
- `npx vitest run unit/proxy-pool-failover.test.js` → 16/16.
- `curl -s localhost:20128/v1/models` → only OpenCode Free models.
- Chat smoke test through a combo:
  `curl -s -X POST localhost:20128/v1/chat/completions -H "Authorization: Bearer $KEY" -d '{"model":"free-autopilot","messages":[{"role":"user","content":"halo"}],"stream":false}'`
- 429 failover: `~/Gateway/mobile-pool/e2e-local.sh` (mock 429 → pool retry).
