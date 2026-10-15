# Tests

Vitest suites for the lean fork. Two trees:

```
tests/
├── unit/        # 100+ focused files (db, auth, keys, combos, capabilities, engine bits)
└── translator/  # data-driven coverage of the format-translation layer
    └── real/    # live-provider suites, gated behind RUN_REAL=1
```

`tests/package.json` installs vitest locally (own `node_modules`). Always run from `tests/`
so `vitest.config.js` (which maps `@/` → `../src` and `open-sse/` → `../open-sse`) applies.

## Run

```bash
cd tests
npm install          # once
npx vitest run       # everything that does not need credentials
npx vitest run unit/proxy-pool-failover.test.js     # a single file
npx vitest run --reporter=verbose
```

The default run is offline: no network, no credentials. The `translator/real/*` suites are
skipped unless you export `RUN_REAL=1`; they then read active connections from
`~/.9router/db/data.sqlite` and hit the live upstreams (only useful against a real
deployment — on this fork that means the OpenCode Free connection).

## What is covered where

| Area | Files |
|---|---|
| Pool chains: ordered failover, `__all__` ordering, round-robin start/fall-through, cooldowns | `unit/proxy-pool-failover` |
| 429 → proxy-pool failover, strict proxy, SSRF guard | `unit/proxy-pool-failover`, `unit/strict-proxy-enforcement`, `unit/ssrf-guard-hardening` |
| Chat path: streaming, SSE→JSON, usage extraction, claude cloaking, tool dedupe, session/fingerprint | `unit/claude-*`, `unit/cached-token-usage`, `unit/extract-usage-cache-shapes`, `unit/session-manager`, `unit/opencode-*`, `unit/tool-deduper` |
| Format translation (kept pairs) | `translator/*` + `unit/gemini-*`, `unit/openai-to-claude-*`, `unit/responses-*`, `unit/thinking-*` |
| Combos (routing, fusion, capabilities) | `unit/combo-*` |
| Dashboard/API surface: keys, auth status, model lookup, provider validation, quirks | `unit/auth-status`, `unit/tenant-*`-style API tests, `unit/model-*`, `unit/compatible-provider-connections`, `unit/bulk-add-names` |
| DB + migrations | `unit/db-migration-chain`, `unit/key-access-migration` |
| Usage stats: recorder + aggregation (pool slices, fail reasons, ranges, retention) | `unit/usage-stats` |
| OpenCode Free (Zen) limits pinned + combo window (`zen-caps`) | `unit/zen-model-limits` |
| Build/asset plumbing | `unit/standalone-assets` |

Suites for removed surface (provider registries, media endpoints, token savers, usage/quota,
i18n, relay deploys) were deleted together with the features — see `LEAN.md`.

## Conventions

- Plain ESM + `vitest`; no setup file. Handlers under test call a patched global `fetch`
  (see `open-sse/utils/proxyFetch.js`) — mock `global.fetch` per file like the existing
  suites do.
- `it.fails(...)` marks a confirmed-but-unfixed bug (passes while the bug exists, turns red
  when fixed) — see `translator/AGENTS.md`.
- After changing anything in `open-sse/` or `src/`, run the full suite before the build:
  `node scripts/lean.mjs audit && node scripts/lean.mjs verify all` from the repo root first.
