# LEAN.md — what this fork keeps, and how to re-strip it

This is a **slim fork** of [decolua/9router](https://github.com/decolua/9router) for one
job: serving **OpenCode Free** models through a **two-IP failover pool** so free-tier rate
limits survive longer, with **combos** on top.

Everything else was removed on purpose. The strip is **scripted** so upstream changes stay
cheap to absorb:

```bash
node scripts/lean.mjs list              # phases + what each one removes
node scripts/lean.mjs apply <phase>     # idempotent; safe to re-run
node scripts/lean.mjs apply all
node scripts/lean.mjs verify all        # fails if a phase is only half-applied
node scripts/lean.mjs audit             # fails when a rule can never apply (check ⊂ find)
```

Phases, in apply order: `updater`, `cli-tools`, `media`, `usage-quota`, `token-saver`,
`sso`, `mitm-tunnel`, `providers`, `cosmetics`, `sweep`, `pool-obs`, `pool-usage`, `zen-caps`.

## What the fork keeps

| Area | Where |
|---|---|
| OpenAI-compatible API (`/v1/chat/completions`, `/v1/models`, `/v1/messages`, `/v1/responses`, `/v1beta`) | `src/app/api/v1/*` |
| OpenCode Free provider (no-auth, fingerprint headers, reasoning echo, per-model `targetFormat`) | `open-sse/providers/registry/opencode.js`, `open-sse/executors/opencode.js` |
| **Proxy-pool failover on 429/5xx** (direct → mobile pool, per-model cooldowns) | `src/lib/network/connectionProxy.js`, `src/sse/services/auth.js`, `src/sse/handlers/chat.js` |
| Proxy Pools dashboard + API | `/dashboard/proxy-pools`, `/api/proxy-pools/*` |
| Combos (round-robin / fallback / fusion) + **vision adapter only** | `open-sse/services/combo.js`, `open-sse/services/capacityAdapter.js` |
| API keys, provider connections, dashboard password login | `/dashboard/endpoint`, `/api/keys`, `/api/providers` |
| Console Log (live server output, **with per-request pool attribution**) | `/dashboard/console-log`, `/api/console-log*` |
| Usage page (attempt-level pool/token stats, fail rates per model) | `/dashboard/pool-usage`, `/api/usage-stats`, `src/lib/usageStats.js` |
| Pool chains: `direct → pools` failover (ordered) or round-robin, per-pool+model cooldowns, in-request walk on 429/5xx | `src/lib/network/connectionProxy.js` (`buildPoolPlan`), `src/sse/handlers/chat.js` |
| "Check setup" diagnostics for a pool (tether, policy route, proxy, exit IP, service) | `/dashboard/proxy-pools` → row button, `/api/proxy-pools/[id]/diagnose` |
| Client-format translation that can actually occur: `openai`, `claude`, `gemini`, `openai-responses`, Ollama-compat (`/v1/api/chat`) | `open-sse/translator/` |

Also kept but inert until used: provider-nodes (custom OpenAI-compatible endpoints), model
aliases/tags, `ENABLE_REQUEST_LOGS` file logging, daily models.dev catalog sync.

## What was removed (and why)

| Phase | Removed | Reason |
|---|---|---|
| `updater` | `/api/version*`, `appUpdater` | ran `npm i -g 9router` — would install **upstream** over this fork |
| `cli-tools` | 30 CLI config writers, MCP stdio bridge, combo presets | only OpenCode is used |
| `media` | image/TTS/STT/video/embedding/web-search/systemone | chat gateway; **vision input stays** |
| `usage-quota` | the upstream usage history/stats stack, quota tracker, auto-ping, per-provider quota fetchers | no paid accounts to track (the fork's own minimal Usage page is added back by `pool-usage`, see below) |
| `token-saver` | RTK, headroom, caveman, ponytail, PXPIPE | prompt compression hurt tool selection |
| `sso` | OIDC + SAML | password-only local dashboard |
| `mitm-tunnel` | MITM proxy, Cloudflare tunnel, Tailscale, watchdog/network monitor | reached over LAN + phone tether |
| `providers` | 137 provider registries, ~28 executors, all OAuth flows/services, background token refresh | keep only OpenCode Free |
| `cosmetics` | docs sites, deploy manifests, npm `cli/`, Skills, Translator, pricing page, promos, sql.js fallback | dead weight |
| `sweep` | see below | maximal pass: cruft + everything the earlier phases left behind |

### The `sweep` phase (maximal pass)

| Bucket | Removed |
|---|---|
| Repo cruft | `CLAUDE.md`, upstream `CHANGELOG.md`, `i18n/` (10 README translations), `.github/`, `.npmignore`, Next template SVGs, `sw.js`, stale dev scripts (`injectDisplayToRegistry`, `migrate-registry`, `test-combo-autoswitch`, `translate-readme`) |
| Assets | 157 of 161 provider icons (kept `opencode.png`, `oai-r.png`, `oai-cc.png`, `anthropic-m.png`), the whole `public/i18n/` literal set |
| Dead modules (0 importers) | `src/store/{providerStore,userStore,index}.js`, `shared/components/{Pagination,Drawer}.js`, `shared/constants/{ttsProviders,coworkPlugins,mitmToolHosts,colors,index}.js`, `lib/updater`, `lib/oauth`, `lib/qoder`, open-sse `config/{codexInstructions,awsConstants,googleTtsLanguages,models,constants,kiroConstants,grokCli}.js`, `utils/{awsEventStream,awsSigv4,codexToolSchema,cursorProtobuf,cursorChecksum,sse,kiroSessionReplay}` + `claudeToolTypeSelfCheck`, `handlers/responsesHandler.js`, `transformer/responsesTransformer.js`, `services/{compact,thoughtSignatureStore,qoderModels,kiroModels,cursorModels,kimchiModels,copilotModels,clinepassModels,nous,grokCliModels}.js`, `shared/{mimoAccount,awsCredentials,machineId,clineEnvelope}`, `shared/qoder/*` |
| Vendor dead ends | serverless relay deploys (`/api/proxy-pools/{vercel,cloudflare,deno,netlify}-deploy` + relay UI + `proxyFetch`/`connectionProxy` branches), live model resolvers for pruned providers (kiro/cursor/cline/copilot/grok-cli/qoder/kimchi/zed/nous), `autoPing` schedule UI + `quotaPingSchedule`, BulkImport Codex/Grok-CLI modals, kilocode/ag-risk/xiaomi-miflow/iflow UI branches |
| Translator prune | provider-only pairs: kiro, cursor, commandcode, ollama-target, vertex, antigravity, gemini-target, claude-target — the OpenCode registry only emits `openai`, `openai-responses` (muse-spark) and `claude` (union-alpha), so the kept pairs are exactly `claude↔openai`, `gemini→openai`, `openai-responses↔openai` |
| i18n layer | `src/i18n/*`, `public/i18n/*`, `/api/locale`, `HeaderLanguage`, `LanguageSwitcher`, `constants/locales.js`, profile-page language card, `translate()` call sites (English literals inline) — dashboard is English-only |
| Dependencies | `chalk`, `enquirer`, `express`, `node-forge`, `ora`, `react-is`, `socks-proxy-agent`, optional `@aws-sdk/credential-providers` → 15 deps + `better-sqlite3` optional |
| Tests | every suite that covered the removed surface (~28 files) + stale `tests/__baseline__/` snapshots |

### The `pool-obs` phase (2-pool chains + observability)

| Feature | Detail |
|---|---|
| Console Log works again | routes restored at `/api/console-log` + `/api/console-log/stream` (the cosmetics phase deleted the old `/api/translator/console-logs` tree; the page kept calling it → 404). Client paths patched. |
| Pool names in the logs | `▶ POST … · POOL:"Mobile (phone tether)" (2/3) · ACC:Public` per attempt, `[PROXY] … pool="Local (host)" (727afab5) | url=…`, `⇄ POOL:"direct" UNAVAILABLE (429) → NEXT POOL "Local (host)"`, and `✔ POOL:"…" served the request after N failed attempt(s)` |
| One chain per upstream call | `buildPoolPlan(provider)` runs once per chat-handler invocation in `src/sse/handlers/chat.js` (a combo model attempt counts as one, so a fallback uses the other pool), then the loop walks the chain. Failover = `[direct, …pools]`; round-robin/random = pools with the start rotated per call; a failed pool falls through to the next entry in the same call (bounded — no loop). |
| Ordered chains | Provider strategy `proxyPoolId: "__all__"` ("All active pools (ordered)" in the card) makes the failover chain include every active pool sorted by `failoverOrder` (default 100), then `createdAt`. |
| `failoverOrder` field | Proxy Pools add/edit form + `#n` badge; stored in the pool's JSON `data` column → **no DB migration**. |
| Check setup | `/api/proxy-pools/[id]/diagnose` (read-only, **no sudo**): pool active → proxy reachable → **exit IP direct vs via proxy** → (mobile pool) tether iface, `ip rule` table 100, phone gateway, local proxy service. UI shows a checklist + a copy button for the setup command. |
| Self-registering mobile pool | `scripts/ensure-pool.mjs --name … --url … --order … [--strict]` upserts the pool straight into `data.sqlite`; `mobile-pool/setup.sh` calls it after re-applying the tether config, so nothing is pasted by hand. |

`pool-obs` also made `apply all` idempotent on an already-stripped tree: a patch whose target
was deleted by another phase is now skipped instead of raising "patch target missing".

### The `pool-usage` phase (Usage page)

| Feature | Detail |
|---|---|
| One row per upstream call | `usageHistory` (existing table, **no migration**) gets a row per attempt: ok rows carry `promptTokens`/`completionTokens` + `tokens:{in,cached,out}` and `meta:{pool,poolKey}`; fail rows carry `meta:{pool,reason}` (`429`, `5xx`, `transport`, `empty`). Rows older than 90 days are pruned (throttled). Legacy rows imported before the fork (empty `meta`) are left alone; delete them once after enabling the feature if you want a clean first view. |
| Recorder | `src/lib/usageStats.js` (normalises every upstream usage shape, fire-and-forget, never throws) + `src/lib/db/repos/usageStatsRepo.js` (SQL). Hooks: `saveUsageStats()` (token rows; pool via `clientRawRequest._poolName`, set per attempt in `src/sse/handlers/chat.js`), the chat loop's `!result.success` branch (fail rows) and `open-sse/services/combo.js` (zero-content seats → reason `empty`). |
| API | `GET /api/usage-stats?range=today|24h|7d|30d|60d` → totals, pool slices (ok attempts by pool + one `Fail` bucket), per-model stats with fail rates/reasons, latest 30 attempts. |
| Page | `/dashboard/pool-usage` (sidebar **Usage**, added by this phase): 4 stat cards (requests with served/failed hint, input, cached, output — no dollars), SVG donut (Local / Mobile / Fail %, `direct` appears only in failover mode) with legend, recent-requests table (model · pool · in/cached/out · status) and a sortable per-model table. **No new dependencies** (hand-rolled SVG donut, no recharts). |
| Paths | The page/API deliberately sit outside `usage-quota`'s delete list (`/dashboard/pool-usage`, `/api/usage-stats`) so `verify all` stays green; the recorder files are plain additions, like the `pool-obs` console-log routes. |

### The `zen-caps` phase (Zen free-tier limits)

The generic capability patterns mis-size the OpenCode Free (Zen) ids — `*step-*` says 128k
while `step-5-preview-free` is a 1M model, and the `-free` DeepSeek/MiMo variants are capped
at 200k although their family patterns say 1M. `zen-caps` pins the six wrong ids at their
models.dev values (checked 2026-10-16, flags kept exactly as the patterns resolved them):

| model | ctx / out |
|---|---|
| `step-5-preview-free` | 1,000,000 / 65,536 |
| `nemotron-3.5-super-vl-free` | 1,048,576 / 131,072 |
| `nemotron-3.5-lightning-free` | 262,144 / 262,144 |
| `cat-jam-free` | 262,144 / 131,072 |
| `mimo-v2.6-flash-free` | 200,000 / 32,000 |
| `deepseek-v4.1-flash-free` | 200,000 / 32,000 |

With that, `free-autopilot` (step-5 + space-bunny + muse-spark-1.3) publishes a **1M** combo
window and `max_completion_tokens` 65,536.

The same phase makes `/v1/models` actually emit those numbers: in this fork the DB holds no
provider rows (OpenCode Free is a virtual no-auth connection), so the route used to take its
"DB unavailable" static branch, which published no `context_length` /
`max_completion_tokens` at all. Counting the synthetic no-auth connections in that check
routes the models through the full per-provider loop instead.

Note: the client (OpenCode CLI/Desktop) does **not** read limits from `/v1/models` for
custom providers — it defaults to `{ context: 200000, output: 32000 }` when a model entry
has no `limit`. `mobile-pool/opencode.jsonc` therefore pins `limit` per model.

**Overlays.** Ten files are deliberate fork rewrites rather than edits, so they live in
full under `scripts/lean/overlays/` and the phase copies them over verbatim:
`providers/[id]/page.js`, `AddApiKeyModal.js`, `ConnectionRow.js`, `providers/[id]/models/route.js`,
`providers/validate/route.js`, `providers/[id]/test/testUtils.js`, `models/test/ping.js`,
`proxy-pools/page.js`, `v1beta/models/[...path]/route.js`, `shared/utils/bulkAdd.js`.
Everything else is patched with find/replace rules so upstream fixes keep flowing in.

## Notable side effects (all intentional)

- `src/lib/usageDb.js` and `open-sse/handlers/chatCore/requestDetail.js` are **stubs /
  log-only**: the chat path still calls them, nothing is persisted. The `📊 DONE … IN/OUT`
  line still prints.
- `src/shared/services/initializeApp.js` is a ~30-line boot service (deferred connection
  housekeeping only).
- `custom-server.js` no longer starts a token-refresh scheduler; `src/proxy.js` is just the
  dashboard auth guard.
- Provider pickers, `/v1/models` and the dashboard derive from the pruned
  `open-sse/providers/registry/index.js` (single entry: `opencode`).
- The `v1beta` (Gemini) route converts clients to the chat path; the native Gemini-provider
  passthrough went out with the media strip.

## Rebase recipe (when upstream changes, e.g. a new Zen fingerprint)

```bash
cd ~/Gateway/9router
git fetch upstream
git rebase upstream/master          # your patch commits live on top
node scripts/lean.mjs audit         # rule sanity (check ⊂ find)
node scripts/lean.mjs verify all    # any conflict left a phase half-applied?
node scripts/lean.mjs apply all     # re-strip idempotently
npm install && npm run build
(cd tests && npx vitest run)
systemctl --user restart 9router
```

If a phase fails with *"patch site not found"*, upstream moved that file: open
`scripts/lean.mjs`, update that one rule (find/replace strings are plain text) — or move the
file to `scripts/lean/overlays/` if the fork owns it outright. Re-run `verify`/`audit` after.

## Adding a provider back

1. Restore `open-sse/providers/registry/<id>.js` (from upstream) and add its import to
   `open-sse/providers/registry/index.js`.
2. If it needs a dedicated executor, restore it and register it in
   `open-sse/executors/index.js`.
3. Remove the id from that phase's keep-list if you want the strip script to stop pruning it.

## Verification checklist

- `node scripts/lean.mjs audit && node scripts/lean.mjs verify all`
- `npm run build` → compiles, static pages generated.
- `(cd tests && npx vitest run)` → all green (~760 tests; `real/` suites skip without `RUN_REAL=1`).
- `curl -s localhost:20128/v1/models` → the combo + `oc/*` models only.
- Pool attribution: send one chat, then check Console Log for `POOL:"…"` on the request line
  and `[PROXY] … pool="…"` (round-robin alternates the start pool per request; failover walks
  `direct → pools` on 429).
- Check setup: Proxy Pools → row button → every check green (mobile) / exit-IP warn is expected
  for `Local (host)`.
- Chat smoke through the combo:
  `curl -s -X POST localhost:20128/v1/chat/completions -H "Authorization: Bearer $KEY" -d '{"model":"free-autopilot","messages":[{"role":"user","content":"hi"}],"stream":false}'`
- 429 failover: `~/Gateway/mobile-pool/e2e-local.sh` (mock 429 → pool retry).
- Dashboard: log in, walk the six pages, removed routes (`/dashboard/skills`, `/api/locale`, …) return 404.

## Inventory (this tree)

| | Before fork | Now |
|---|---|---|
| JS files (`src` + `open-sse`) | 976 | 286 |
| `src/` size | 5.8 MB | 1.7 MB |
| `open-sse/` size | 3.4 MB | 1.1 MB |
| Dependencies | 34 | 15 (+1 optional) |
| `node_modules` | 731 MB | ~530 MB |
| Test files | 143 | 115 |
