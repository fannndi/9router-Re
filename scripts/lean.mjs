#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// lean.mjs — fork-slimming tool for fannndi/9router-Re
//
// The fork keeps only what the free-tier multi-IP gateway needs:
//   providers(opencode free) + proxy pools + combos + API keys + vision input.
// Everything else (cli-tools, media, usage/quota, token savers, mitm, tunnel,
// sso, updater, extra providers) is stripped.
//
// Why a script instead of only commits: upstream moves fast (Zen fingerprints,
// new providers every week). After `git rebase upstream/master` the strip can be
// re-applied with one command instead of resolving deletions by hand:
//
//   node scripts/lean.mjs list
//   node scripts/lean.mjs apply updater
//   node scripts/lean.mjs apply all
//   node scripts/lean.mjs verify all
//
// Rules are idempotent and fail loudly when upstream changed a patch site, so a
// rebase never silently leaves a half-stripped tree.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ─── helpers ────────────────────────────────────────────────────────────────

const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function exists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

/**
 * Apply one patch rule. Throws when the site disappeared upstream.
 * Rule shapes:
 *   { file, find, replace }               — unique replace (replace may be "")
 *   { file, find, replace, checkAbsent }  — idempotent for empty replacements
 *   { file, cutFrom }                     — delete everything from marker to EOF
 */
function applyPatch(rule, { dry = false } = {}) {
  const abs = path.join(ROOT, rule.file);
  if (!fs.existsSync(abs)) {
    throw new Error(`patch target missing: ${rule.file}`);
  }
  let src = fs.readFileSync(abs, "utf8");

  if (rule.cutFrom) {
    const idx = src.indexOf(rule.cutFrom);
    // Marker gone → an earlier run cut the tail already (idempotent).
    if (idx === -1) return "skip";
    if (!dry) fs.writeFileSync(abs, src.slice(0, idx).trimEnd() + "\n");
    return "applied";
  }

  const { find, replace = "", checkAbsent = false } = rule;
  if (!find) throw new Error(`patch rule without find/cutFrom in ${rule.file}`);

  // "Already applied" must be decided before looking at `find`: insertion-style
  // patches keep their anchor line, so a present `find` alone proves nothing.
  if (rule.check && src.includes(rule.check)) return "skip";
  if (checkAbsent && !src.includes(find)) return "skip";

  if (src.includes(find)) {
    const next = src.split(find).length - 1 > 1 && !rule.allowMultiple
      ? null
      : src.replace(find, replace);
    if (next === null) {
      throw new Error(`patch site is not unique in ${rule.file} (${JSON.stringify(find.slice(0, 60))}…)`);
    }
    if (!dry) fs.writeFileSync(abs, next);
    return "applied";
  }

  // Already applied?
  if (checkAbsent) return "skip";
  if (rule.check ? src.includes(rule.check) : replace && src.includes(replace)) return "skip";

  throw new Error(
    `patch site not found in ${rule.file}:\n---\n${find.slice(0, 200)}\n---\n` +
      `Upstream probably changed this file. Update the rule in scripts/lean.mjs.`
  );
}

function applyPhase(phase, { dry = false, quiet = false } = {}) {
  const log = (msg) => !quiet && console.log(msg);
  let deleted = 0;
  let patched = 0;
  let skipped = 0;

  for (const rel of phase.delete || []) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) && !fs.existsSync(abs + ".js")) {
      skipped++;
      continue;
    }
    if (!dry) fs.rmSync(abs, { recursive: true, force: true });
    deleted++;
    log(c.dim(`  - rm ${rel}`));
  }

  for (const rule of phase.patch || []) {
    const res = applyPatch(rule, { dry });
    if (res === "applied") {
      patched++;
      log(c.dim(`  ~ edit ${rule.file}`));
    } else {
      skipped++;
    }
  }

  return { deleted, patched, skipped };
}

function removeDeps(phase, { dry = false, quiet = false } = {}) {
  if (!phase.deps?.remove?.length) return { removed: 0 };
  const pkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  let removed = 0;
  for (const dep of phase.deps.remove) {
    if (pkg.dependencies?.[dep]) {
      delete pkg.dependencies[dep];
      removed++;
      if (!quiet) console.log(c.dim(`  - dep ${dep}`));
    }
  }
  if (!dry && removed) fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return { removed };
}

function cmdList() {
  console.log(c.bold("lean.mjs phases"));
  for (const [id, phase] of Object.entries(PHASES)) {
    const files = (phase.delete || []).length;
    const patches = (phase.patch || []).length;
    const deps = (phase.deps?.remove || []).length;
    console.log(`  ${id.padEnd(14)} ${phase.title}`);
    console.log(
      c.dim(`                 ${files} path(s) deleted, ${patches} patch(es), ${deps} dep(s) removed`)
    );
  }
}

function resolvePhases(args) {
  if (!args.length || args.includes("all")) return Object.keys(PHASES);
  const wanted = [];
  for (const a of args) {
    if (!PHASES[a]) throw new Error(`unknown phase: ${a}`);
    wanted.push(a);
  }
  return wanted;
}

function cmdApply(args) {
  const dry = args.includes("--dry");
  const phases = resolvePhases(args.filter((a) => a !== "--dry"));
  for (const id of phases) {
    const phase = PHASES[id];
    console.log(`\n${c.bold(`▶ ${id}`)} — ${phase.title}`);
    const { deleted, patched, skipped } = applyPhase(phase, { dry });
    const { removed } = removeDeps(phase, { dry });
    console.log(
      `  ${c.green(`${deleted} deleted`)}, ${c.green(`${patched} patched`)}, ` +
        `${skipped} already done${removed ? `, ${removed} deps removed` : ""}${dry ? c.yellow(" (dry run)") : ""}`
    );
  }
  if (!dry) {
    const phasesLeft = Object.keys(PHASES).filter((id) => !phases.includes(id));
    if (phasesLeft.length) {
      console.log(c.dim(`\nremaining phases: ${phasesLeft.join(", ")}`));
    }
    console.log(c.green("\nOK. Next: npm run build && npx vitest run unit/proxy-pool-failover.test.js"));
  }
}

function cmdVerify(args) {
  const phases = resolvePhases(args);
  let problems = 0;
  for (const id of phases) {
    const phase = PHASES[id];
    const leftoverPaths = (phase.delete || []).filter((rel) => exists(rel));
    const leftoverPatches = (phase.patch || []).filter((rule) => {
      try {
        const src = read(rule.file);
        if (rule.cutFrom) return src.includes(rule.cutFrom);
        if (rule.check) return !src.includes(rule.check);
        return src.includes(rule.find);
      } catch {
        return true; // file missing → unresolved
      }
    });
    const leftoverDeps = (phase.deps?.remove || []).filter((dep) => {
      const pkg = JSON.parse(read("package.json"));
      return !!pkg.dependencies?.[dep];
    });
    if (leftoverPaths.length || leftoverPatches.length || leftoverDeps.length) {
      problems++;
      console.log(c.red(`✗ ${id} not fully applied`));
      for (const p of leftoverPaths) console.log(c.red(`    path still present: ${p}`));
      for (const p of leftoverPatches) console.log(c.red(`    patch site still present: ${p.file}`));
      for (const d of leftoverDeps) console.log(c.red(`    dep still present: ${d}`));
    } else {
      console.log(c.green(`✓ ${id} applied`));
    }
  }
  if (problems) process.exitCode = 1;
}

// ─── phases ────────────────────────────────────────────────────────────────

const PHASES = {
  // 1 ── updater: the single most dangerous feature in a fork. It ran
  // `npm i -g 9router`, i.e. it would overwrite this fork's own build.
  updater: {
    title: "drop npm self-updater (would install upstream over this fork)",
    delete: ["src/app/api/version", "src/app/api/shutdown", "src/lib/appUpdater.js"],
    patch: [
      {
        file: "src/shared/constants/config.js",
        find: `// Updater configuration
export const UPDATER_CONFIG = {
  npmPackageName: "9router",
  installCmd: "npm i -g 9router",
  installCmdLatest: "npm i -g 9router@latest --prefer-online",
  shutdownCountdownSec: 3,
  exitDelayMs: 500,
  statusPort: 20129,
  statusPollIntervalMs: 1000,
  statusLogTailLines: 8,
  installRetries: 3,
  installRetryDelayMs: 5000,
  lingerAfterDoneMs: 30000,
  waitForExitMinMs: 5000,
  waitForExitMaxMs: 20000,
  waitForExitCheckMs: 500,
  appPort: 20128,
};

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `import { APP_CONFIG, UPDATER_CONFIG } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import useSettingsStore from "@/store/settingsStore";
import Button from "./Button";
import { ConfirmModal } from "./Modal";`,
        replace: `import { APP_CONFIG } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import useSettingsStore from "@/store/settingsStore";`,
        check: `import { APP_CONFIG } from "@/shared/constants/config";`,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `  const [isDisconnected, setIsDisconnected] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [shutdownCountdown, setShutdownCountdown] = useState(0);
  const [enableTranslator, setEnableTranslator] = useState(false);
  const { copied, copy } = useCopyToClipboard(2000);

  const INSTALL_CMD = UPDATER_CONFIG.installCmdLatest;`,
        replace: `  const [enableTranslator, setEnableTranslator] = useState(false);`,
        check: `const [enableTranslator, setEnableTranslator] = useState(false);`,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `
  // Lazy check for new npm version in background after initial render
  useEffect(() => {
    const timer = setTimeout(() => {
      fetch("/api/version")
        .then(res => res.json())
        .then(data => { if (data.hasUpdate) setUpdateInfo(data); })
        .catch(() => {});
    }, 2500);
    return () => clearTimeout(timer);
  }, []);
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `  // Open manual update panel (no countdown yet — user must click Copy to trigger shutdown)
  const handleUpdate = () => {
    setShowUpdateModal(false);
    setIsUpdating(true);
  };

  // Triggered by Copy button inside ManualUpdatePanel: copy + countdown + shutdown
  const handleCopyAndShutdown = async () => {
    try { await navigator.clipboard.writeText(INSTALL_CMD); } catch { /* clipboard blocked */ }
    copy(INSTALL_CMD);
    let remaining = UPDATER_CONFIG.shutdownCountdownSec;
    setShutdownCountdown(remaining);
    const timer = setInterval(() => {
      remaining -= 1;
      setShutdownCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(timer);
        fetch("/api/version/shutdown", { method: "POST" }).catch(() => {});
        setIsDisconnected(true);
      }
    }, 1000);
  };

  const handleCancelUpdate = () => {
    setIsUpdating(false);
    setShutdownCountdown(0);
  };

  // Note: legacy updater poll removed. New flow: copy install cmd + shutdown server,
  // user runs the command manually in another terminal.

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `          {updateInfo && (
            <div className="flex flex-col gap-1.5 rounded p-1 -m-1">
              <span className="text-xs font-semibold text-green-600 dark:text-amber-500">
                ↑ New version available: v{updateInfo.latestVersion}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowUpdateModal(true)}
                  className="px-2 py-1 rounded bg-green-600 hover:bg-green-700 dark:bg-amber-500 dark:hover:bg-amber-600 text-white text-[11px] font-semibold transition-colors cursor-pointer"
                >
                  Update now
                </button>
                <button
                  onClick={() => copy(INSTALL_CMD)}
                  title="Copy install command"
                  className="flex-1 text-left hover:opacity-80 transition-opacity cursor-pointer min-w-0"
                >
                  <code className="block text-[10px] text-green-600/80 dark:text-amber-400/70 font-mono truncate">
                    {copied ? "✓ copied!" : INSTALL_CMD}
                  </code>
                </button>
              </div>
            </div>
          )}
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `
      {/* Update Confirmation Modal */}
      <ConfirmModal
        isOpen={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        onConfirm={handleUpdate}
        title="Update 9Router"
        message={\`Show install command for v\${updateInfo?.latestVersion || ""}? You can copy it and shutdown to install manually.\`}
        confirmText="Show Command"
        cancelText="Cancel"
        variant="primary"
      />

      {/* Disconnected / Updating Overlay */}
      {(isDisconnected || isUpdating) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
          {isUpdating ? (
            <ManualUpdatePanel
              latestVersion={updateInfo?.latestVersion}
              installCmd={INSTALL_CMD}
              copied={copied}
              onCopyAndShutdown={handleCopyAndShutdown}
              onCancel={handleCancelUpdate}
              countdown={shutdownCountdown}
              isDisconnected={isDisconnected}
            />
          ) : (
            <div className="text-center p-8">
              <div className="flex items-center justify-center size-16 rounded-full bg-red-500/20 text-red-500 mx-auto mb-4">
                <span className="material-symbols-outlined text-[32px]">power_off</span>
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Server Disconnected</h2>
              <p className="text-text-muted mb-6">The proxy server has been stopped.</p>
              <Button variant="secondary" onClick={() => globalThis.location.reload()}>
                Reload Page
              </Button>
            </div>
          )}
        </div>
      )}
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        cutFrom: "function ManualUpdatePanel({",
      },
      {
        file: "src/dashboardGuard.js",
        find: `  "/api/auth/saml",
  "/api/version",
  "/api/settings/require-login",`,
        replace: `  "/api/auth/saml",
  "/api/settings/require-login",`,
        check: `  "/api/settings/require-login",`,
      },
      {
        file: "src/dashboardGuard.js",
        find: `const ALWAYS_PROTECTED = [
  "/api/shutdown",
  "/api/settings/database",
  "/api/version/shutdown",
  "/api/version/update",
`,
        replace: `const ALWAYS_PROTECTED = [
  "/api/settings/database",
`,
        check: `const ALWAYS_PROTECTED = [`,
      },
      {
        file: "src/shared/constants/config.js",
        find: `// Theme configuration
export const THEME_CONFIG = {`,
        replace: `// App port used by internal self-tests (model ping / provider test). PORT is
// injected by the systemd unit; 20128 is the upstream default.
export const APP_PORT = Number(process.env.PORT || 20128);

// Theme configuration
export const THEME_CONFIG = {`,
        check: `export const APP_PORT`,
      },
      {
        file: "src/app/api/models/test/ping.js",
        find: `import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";`,
        replace: `import { APP_PORT } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";`,
        check: `import { APP_PORT } from "@/shared/constants/config";`,
      },
      {
        file: "src/app/api/models/test/ping.js",
        find: "baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`",
        replace: "baseUrl = `http://127.0.0.1:${APP_PORT}`",
      },
      {
        file: "src/app/api/providers/[id]/test-models/route.js",
        find: `import { UPDATER_CONFIG } from "@/shared/constants/config";
import { pingModelByKind } from "@/app/api/models/test/ping";`,
        replace: `import { APP_PORT } from "@/shared/constants/config";
import { pingModelByKind } from "@/app/api/models/test/ping";`,
        check: `import { APP_PORT } from "@/shared/constants/config";`,
      },
      {
        file: "src/app/api/providers/[id]/test-models/route.js",
        find: "const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;",
        replace: "const baseUrl = `http://127.0.0.1:${APP_PORT}`;",
      },
      {
        file: "src/shared/components/HeaderMenu.js",
        find: `  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const { toggleTheme, isDark } = useTheme();
  const menuRef = useRef(null);

  const handleShutdown = async () => {
    setIsShuttingDown(true);
    try {
      await fetch("/api/version/shutdown", { method: "POST" });
    } catch (e) {
      // Expected to fail as server shuts down; ignore error
    }
    setIsShuttingDown(false);
    setShutdownOpen(false);
  };

`,
        replace: `  const { toggleTheme, isDark } = useTheme();
  const menuRef = useRef(null);

`,
        checkAbsent: true,
      },
      {
        file: "src/shared/components/HeaderMenu.js",
        find: `            <MenuItem
              icon="power_settings_new"
              label="Shutdown"
              danger
              onClick={() => { close(); setShutdownOpen(true); }}
            />
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/HeaderMenu.js",
        find: `      <ConfirmModal
        isOpen={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title="Close Proxy"
        message="Are you sure you want to close the proxy server?"
        confirmText="Close"
        cancelText="Cancel"
        variant="danger"
        loading={isShuttingDown}
      />
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/HeaderMenu.js",
        find: `import ChangelogModal from "./ChangelogModal";
import { ConfirmModal } from "./Modal";`,
        replace: `import ChangelogModal from "./ChangelogModal";`,
        check: `import ChangelogModal from "./ChangelogModal";`,
      },
      {
        file: "src/app/api/cli-tools/cowork-settings/route.js",
        find: `import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const APP_PORT = UPDATER_CONFIG.appPort;`,
        replace: `import { APP_PORT } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";`,
        check: `import { APP_PORT } from "@/shared/constants/config";`,
      },
      {
        file: "src/app/(dashboard)/dashboard/cli-tools/components/BaseUrlSelect.js",
        find: `import { UPDATER_CONFIG } from "@/shared/constants/config";`,
        replace: `import { APP_PORT } from "@/shared/constants/config";`,
        check: `import { APP_PORT } from "@/shared/constants/config";`,
      },
      {
        file: "src/app/(dashboard)/dashboard/cli-tools/components/BaseUrlSelect.js",
        find: "wrap(`http://127.0.0.1:${UPDATER_CONFIG.appPort}`)",
        replace: "wrap(`http://127.0.0.1:${APP_PORT}`)",
      },
      {
        file: "src/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js",
        find: `import { UPDATER_CONFIG } from "@/shared/constants/config";`,
        replace: `import { APP_PORT } from "@/shared/constants/config";`,
        check: `import { APP_PORT } from "@/shared/constants/config";`,
      },
      {
        file: "src/app/(dashboard)/dashboard/cli-tools/components/cliEndpointPresets.js",
        find: "`http://127.0.0.1:${UPDATER_CONFIG.appPort}`",
        replace: "`http://127.0.0.1:${APP_PORT}`",
      },
      {
        file: "src/app/(dashboard)/dashboard/profile/page.js",
        find: `  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/(dashboard)/dashboard/profile/page.js",
        find: `  const handleShutdown = async () => {
    setIsShuttingDown(true);
    try {
      await fetch("/api/version/shutdown", { method: "POST" });
    } catch (e) {
      // Expected to fail as server shuts down; ignore error
    }
    setIsShuttingDown(false);
    setShutdownOpen(false);
  };

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/(dashboard)/dashboard/profile/page.js",
        find: `          <Button
            variant="outline"
            fullWidth
            icon="power_settings_new"
            onClick={() => setShutdownOpen(true)}
            className="text-red-500 border-red-200 hover:bg-red-50 hover:border-red-300"
          >
            Shutdown
          </Button>
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/(dashboard)/dashboard/profile/page.js",
        find: `      <ConfirmModal
        isOpen={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title="Close Proxy"
        message="Are you sure you want to close the proxy server?"
        confirmText="Close"
        cancelText="Cancel"
        variant="danger"
        loading={isShuttingDown}
      />
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/(dashboard)/dashboard/profile/page.js",
        find: `import Modal, { ConfirmModal } from "@/shared/components/Modal";`,
        replace: `import Modal from "@/shared/components/Modal";`,
        check: `import Modal from "@/shared/components/Modal";`,
      },
    ],
  },

  // 2 ── CLI Tools: 30 integrations that only rewrite other tools' config files
  // (claude/codex/cline/jcode/…). This fork ships OpenCode only.
  "cli-tools": {
    title: "drop CLI Tools dashboard + api, MCP stdio bridge, Cursor/Claude combo presets",
    delete: [
      "src/app/api/cli-tools",
      "src/app/(dashboard)/dashboard/cli-tools",
      "src/app/api/mcp",
      "src/lib/mcp",
      "src/shared/constants/cliTools.js",
      "src/shared/components/McpMarketplaceModal.js",
      "src/lib/comboPresets.js",
      "src/app/api/combos/presets",
    ],
    deps: { remove: ["confbox"] },
    patch: [
      {
        file: "src/shared/components/Sidebar.js",
        find: `  { href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal" },
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Header.js",
        find: `  if (pathname.includes("/cli-tools"))
    return {
      title: "CLI Tools",
      description: "Configure CLI tools",
      icon: "terminal",
      breadcrumbs: [],
    };
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/dashboardGuard.js",
        find: `  "/api/cli-tools",
  "/api/mcp",
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/dashboardGuard.js",
        find: `  "/api/cli-tools/cowork-settings",
  "/api/cli-tools/antigravity-mitm",
  "/api/mcp/",
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/index.js",
        find: `export { default as McpMarketplaceModal } from "./McpMarketplaceModal";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/(dashboard)/dashboard/combos/page.js",
        find: `  const [presetLoading, setPresetLoading] = useState(null); // "cursor" | "claude" | null
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/(dashboard)/dashboard/combos/page.js",
        find: `  const handleGeneratePresets = async (source) => {
    const label = source === "cursor" ? "Cursor Default" : "Claude Default";
    setPresetLoading(source);
    try {
      const previewRes = await fetch(\`/api/combos/presets?source=\${source}\`);
      const preview = await previewRes.json();
      if (!previewRes.ok) {
        alert(preview.error || \`Failed to preview \${label}\`);
        return;
      }

      const toCreate = preview.toCreate ?? (preview.items || []).filter((i) => !i.exists).length;
      const toSkip = preview.toSkip ?? (preview.items || []).filter((i) => i.exists).length;
      const total = (preview.items || []).length;

      if (total === 0) {
        alert(\`No \${label} models available to generate.\`);
        return;
      }

      if (toCreate === 0) {
        alert(\`All \${total} \${label} combos already exist. Nothing to create.\`);
        return;
      }

      setConfirmState({
        title: \`Generate \${label}\`,
        message: \`Create \${toCreate} combo\${toCreate === 1 ? "" : "s"} named like \${source === "cursor" ? "Cursor" : "Claude"} model IDs (seeded with cu/… or cc/…). \${toSkip} already exist and will be skipped. You can edit any combo afterward to add fallbacks.\`,
        confirmText: "Generate",
        variant: "primary",
        onConfirm: async () => {
          setConfirmState((prev) => prev ? { ...prev, loading: true } : null);
          try {
            const res = await fetch("/api/combos/presets", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ source }),
            });
            const data = await res.json();
            if (!res.ok) {
              alert(data.error || \`Failed to generate \${label}\`);
              return;
            }
            await fetchData();
            setConfirmState(null);
          } catch (error) {
            console.log(\`Error generating \${label}:\`, error);
            alert(\`Failed to generate \${label}\`);
            setConfirmState((prev) => prev ? { ...prev, loading: false } : null);
          }
        },
      });
    } catch (error) {
      console.log(\`Error previewing \${label}:\`, error);
      alert(\`Failed to preview \${label}\`);
    } finally {
      setPresetLoading(null);
    }
  };

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/(dashboard)/dashboard/combos/page.js",
        find: `          <p className="hidden text-xs text-text-muted mt-3 max-w-2xl">
            <span className="font-medium text-text-main">Cursor / Claude Default</span> create combos named exactly like those clients&apos; model IDs (e.g. <code className="font-mono">composer-2.5</code>, <code className="font-mono">opus</code>), seeded with the matching <code className="font-mono">cu/…</code> or <code className="font-mono">cc/…</code> route so traffic can hit 9router without the prefix.
            {" "}Note: Cursor IDE itself often blocks built-in Composer / Grok from Override OpenAI Base URL (&quot;model does not support custom API&quot;); add them via Cursor&apos;s <span className="font-medium text-text-main">Add Custom Model</span> using the combo name, or pick a model Cursor allows through the custom endpoint.
          </p>
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/(dashboard)/dashboard/combos/page.js",
        find: `          <div className="hidden">
            <Button
              variant="secondary"
              size="sm"
              icon="edit_note"
              loading={presetLoading === "cursor"}
              disabled={!!presetLoading}
              onClick={() => handleGeneratePresets("cursor")}
              className="w-full whitespace-nowrap"
            >
              Cursor Default
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon="smart_toy"
              loading={presetLoading === "claude"}
              disabled={!!presetLoading}
              onClick={() => handleGeneratePresets("claude")}
              className="w-full whitespace-nowrap"
            >
              Claude Default
            </Button>
          </div>
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/(dashboard)/dashboard/combos/page.js",
        find: `      {/* Confirm (delete / generate presets) */}`,
        replace: `      {/* Confirm delete */}`,
        check: `{/* Confirm delete */}`,
      },
    ],
  },

  // 3 ── Media: image generation, TTS/STT, video, embeddings, web search/fetch.
  // The fork is a chat gateway: vision *input* stays (capacityAdapter.vision),
  // everything that generates or transcribes media goes away.
  media: {
    title: "drop media providers (image/tts/stt/video/embedding/search/fetch/systemone), keep vision input",
    delete: [
      "src/app/(dashboard)/dashboard/media-providers",
      "src/app/api/media-providers",
      "src/app/api/v1/audio",
      "src/app/api/v1/images",
      "src/app/api/v1/videos",
      "src/app/api/v1/embeddings",
      "src/app/api/v1/search",
      "src/app/api/v1/systemone",
      "src/app/api/v1/web",
      "src/sse/handlers/tts.js",
      "src/sse/handlers/stt.js",
      "src/sse/handlers/imageGeneration.js",
      "src/sse/handlers/videoGeneration.js",
      "src/sse/handlers/embeddings.js",
      "src/sse/handlers/search.js",
      "src/sse/handlers/fetch.js",
      "src/sse/handlers/systemone.js",
      "open-sse/handlers/ttsCore.js",
      "open-sse/handlers/ttsProviders",
      "open-sse/handlers/sttCore.js",
      "open-sse/handlers/geminiLiveStt.js",
      "open-sse/handlers/imageGenerationCore.js",
      "open-sse/handlers/imageProviders",
      "open-sse/handlers/videoCore.js",
      "open-sse/handlers/videoProviders",
      "open-sse/handlers/embeddingsCore.js",
      "open-sse/handlers/embeddingProviders",
      "open-sse/handlers/search",
      "open-sse/handlers/fetch",
      "open-sse/handlers/systemoneCore.js",
      "open-sse/config/ttsModels.js",
    ],
    patch: [
      {
        file: "open-sse/providers/index.js",
        find: `import { buildTtsProviderModels } from "../config/ttsModels.js";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "open-sse/providers/index.js",
        find: `
// TTS model/voice tables keyed by special names (openai-tts-models, ...), not provider ids
Object.assign(PROVIDER_MODELS, buildTtsProviderModels());`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `// const VISIBLE_MEDIA_KINDS = ["embedding", "image", "imageToText", "tts", "stt", "webSearch", "webFetch", "video", "music"];
const VISIBLE_MEDIA_KINDS = ["embedding", "image", "video", "tts", "stt", "systemone"];
// Combined entry: webSearch + webFetch share one page at /dashboard/media-providers/web
const COMBINED_WEB_ITEM = { id: "web", label: "Web Fetch & Search", icon: "travel_explore", href: "/dashboard/media-providers/web" };

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `  const [mediaOpen, setMediaOpen] = useState(false);
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `            {/* Media Providers accordion */}
            <button
              onClick={() => setMediaOpen((v) => !v)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-1 rounded-lg transition-all group",
                pathname.startsWith("/dashboard/media-providers")
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[18px]">perm_media</span>
              <span className="text-[13px] font-medium flex-1 text-left">Media Providers</span>
              <span className="material-symbols-outlined text-[14px] transition-transform" style={{ transform: mediaOpen ? "rotate(180deg)" : "rotate(0deg)" }}>
                expand_more
              </span>
            </button>
            {mediaOpen && (
              <div className="pl-4">
                {MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map((kind) => (
                  <Link
                    key={kind.id}
                    href={\`/dashboard/media-providers/\${kind.id}\`}
                    onClick={onClose}
                    className={cn(
                      "flex items-center gap-3 px-4 py-1 rounded-lg transition-all group",
                      pathname.startsWith(\`/dashboard/media-providers/\${kind.id}\`)
                        ? "bg-primary/10 text-primary"
                        : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                    )}
                  >
                    <span className="material-symbols-outlined text-[16px]">{kind.icon}</span>
                    <span className="text-sm">{kind.label}</span>
                  </Link>
                ))}
                <Link
                  key={COMBINED_WEB_ITEM.id}
                  href={COMBINED_WEB_ITEM.href}
                  onClick={onClose}
                  className={cn(
                    "flex items-center gap-3 px-4 py-1 rounded-lg transition-all group",
                    pathname.startsWith(COMBINED_WEB_ITEM.href)
                      ? "bg-primary/10 text-primary"
                      : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                  )}
                >
                  <span className="material-symbols-outlined text-[16px]">{COMBINED_WEB_ITEM.icon}</span>
                  <span className="text-sm">{COMBINED_WEB_ITEM.label}</span>
                </Link>
              </div>
            )}

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Header.js",
        find: `import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS } from "@/shared/constants/providers";`,
        replace: `import { AI_PROVIDERS } from "@/shared/constants/providers";`,
        check: `import { AI_PROVIDERS } from "@/shared/constants/providers";`,
      },
      {
        file: "src/shared/components/Header.js",
        find: `  // Media provider detail: /dashboard/media-providers/[kind]/[id]
  const mediaDetailMatch = pathname.match(/\\/media-providers\\/([^/]+)\\/([^/]+)$/);
  if (mediaDetailMatch) {
    const kindId = mediaDetailMatch[1];
    const providerId = mediaDetailMatch[2];
    const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    const provider = AI_PROVIDERS[providerId];
    return {
      title: provider?.name || providerId,
      description: "",
      breadcrumbs: [
        { label: "Media Providers", href: \`/dashboard/media-providers/\${kindId}\` },
        { label: kindConfig?.label || kindId, href: \`/dashboard/media-providers/\${kindId}\` },
        { label: provider?.name || providerId, image: getProviderIconSrc(providerId) },
      ],
    };
  }

  // Media provider kind: /dashboard/media-providers/[kind]
  const mediaKindMatch = pathname.match(/\\/media-providers\\/([^/]+)$/);
  if (mediaKindMatch) {
    const kindId = mediaKindMatch[1];
    const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    return {
      title: kindConfig?.label || kindId,
      description: \`Manage your \${kindConfig?.label || kindId} providers\`,
      icon: kindConfig?.icon || "perm_media",
      breadcrumbs: [],
    };
  }

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Header.js",
        find: `  if (pathname.includes("/providers") && !pathname.includes("/media-providers"))`,
        replace: `  if (pathname.includes("/providers"))`,
      },
      {
        file: "open-sse/services/capacityAdapter.js",
        find: ` * Capacity Adapter — global fallback pools of models per input-modality capability
 * (vision / pdf / audioInput / videoInput).`,
        replace: ` * Capacity Adapter — fallback pool of vision models for image input.
 *
 * Media *generation* (image/tts/stt/video) was removed from this fork; only the
 * vision pool remains so text-only combos still answer image requests.`,
        check: `fallback pool of vision models for image input`,
      },
      {
        file: "open-sse/services/capacityAdapter.js",
        find: `const CAPABILITY_KEYS = ["vision", "pdf", "audioInput", "videoInput"];`,
        replace: `const CAPABILITY_KEYS = ["vision"];`,
        check: `const CAPABILITY_KEYS = ["vision"];`,
      },
      {
        file: "src/lib/db/repos/settingsRepo.js",
        find: `  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },`,
        replace: `  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
  },`,
        check: `  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
  },`,
      },
      {
        file: "src/app/(dashboard)/dashboard/combos/page.js",
        find: `const CAPACITY_ADAPTER_CAPS = [
  { key: "vision", label: "Vision", icon: "visibility", desc: "images (png, jpg, webp, …)" },
  // pdf, videoInput temporarily hidden — no translator support yet for those blocks.
  { key: "audioInput", label: "Audio", icon: "graphic_eq", desc: "audio input" },
];`,
        replace: `const CAPACITY_ADAPTER_CAPS = [
  { key: "vision", label: "Vision", icon: "visibility", desc: "images (png, jpg, webp, …)" },
];`,
        check: `const CAPACITY_ADAPTER_CAPS = [`,
      },
      {
        file: "src/app/(dashboard)/dashboard/combos/page.js",
        find: `const EMPTY_CAPACITY_ADAPTER = {
  vision: { ...EMPTY_CAP_ENTRY },
  pdf: { ...EMPTY_CAP_ENTRY },
  audioInput: { ...EMPTY_CAP_ENTRY },
  videoInput: { ...EMPTY_CAP_ENTRY },
};`,
        replace: `const EMPTY_CAPACITY_ADAPTER = {
  vision: { ...EMPTY_CAP_ENTRY },
};`,
        check: `const EMPTY_CAPACITY_ADAPTER = {`,
      },
    ],
  },
};

// ─── cli ───────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (!cmd || cmd === "list") cmdList();
  else if (cmd === "apply") cmdApply(rest);
  else if (cmd === "verify") cmdVerify(rest);
  else {
    console.log(`usage: node scripts/lean.mjs <list|apply|verify> [phase…|all] [--dry]`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(c.red(`\n✗ ${err.message}`));
  process.exitCode = 1;
}
