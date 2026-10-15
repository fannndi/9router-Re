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

  if (rule.writeFile !== undefined) {
    if (rule.check && src.includes(rule.check)) return "skip";
    if (!dry) fs.writeFileSync(abs, rule.writeFile);
    return "applied";
  }

  if (rule.cutTo) {
    const start = src.indexOf(rule.find ?? "");
    // Start marker gone → an earlier run already cut the range (idempotent).
    if (start === -1) return "skip";
    const end = src.indexOf(rule.cutTo, start);
    if (end === -1) {
      throw new Error(`cutTo end marker not found after start in ${rule.file}: ${JSON.stringify(rule.cutTo)}`);
    }
    if (!dry) fs.writeFileSync(abs, src.slice(0, start) + src.slice(end));
    return "applied";
  }

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
    const matches = src.split(find).length - 1;
    if (matches > 1 && !rule.allowMultiple) {
      throw new Error(`patch site is not unique in ${rule.file} (${JSON.stringify(find.slice(0, 60))}…)`);
    }
    const next = rule.allowMultiple ? src.split(find).join(replace) : src.replace(find, replace);
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

  // pruneDir: empty a directory except the keep-list (used for the static
  // provider-registry / executor import lists).
  for (const spec of phase.pruneDir || []) {
    const dirAbs = path.join(ROOT, spec.dir);
    if (!fs.existsSync(dirAbs)) {
      skipped++;
      continue;
    }
    const keep = new Set(spec.keep || []);
    for (const entry of fs.readdirSync(dirAbs)) {
      if (keep.has(entry)) continue;
      if (!dry) fs.rmSync(path.join(dirAbs, entry), { recursive: true, force: true });
      deleted++;
      log(c.dim(`  - rm ${spec.dir}/${entry}`));
    }
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
      let src;
      try {
        src = read(rule.file);
      } catch {
        // Patch target already gone (e.g. deleted by a later phase) → resolved.
        return false;
      }
      if (rule.cutFrom) return src.includes(rule.cutFrom);
      if (rule.check) return !src.includes(rule.check);
      return src.includes(rule.find);
    });
    const leftoverDeps = (phase.deps?.remove || []).filter((dep) => {
      const pkg = JSON.parse(read("package.json"));
      return !!pkg.dependencies?.[dep];
    });
    const leftoverPrunes = (phase.pruneDir || []).flatMap((spec) => {
      const dirAbs = path.join(ROOT, spec.dir);
      if (!fs.existsSync(dirAbs)) return [];
      const keep = new Set(spec.keep || []);
      return fs
        .readdirSync(dirAbs)
        .filter((entry) => !keep.has(entry))
        .map((entry) => `${spec.dir}/${entry}`);
    });
    if (leftoverPaths.length || leftoverPatches.length || leftoverDeps.length || leftoverPrunes.length) {
      problems++;
      console.log(c.red(`✗ ${id} not fully applied`));
      for (const p of leftoverPaths) console.log(c.red(`    path still present: ${p}`));
      for (const p of leftoverPatches) console.log(c.red(`    patch site still present: ${p.file}`));
      for (const d of leftoverDeps) console.log(c.red(`    dep still present: ${d}`));
      for (const p of leftoverPrunes) console.log(c.red(`    dir entry still present: ${p}`));
    } else {
      console.log(c.green(`✓ ${id} applied`));
    }
  }
  if (problems) process.exitCode = 1;
}

// ─── phases ────────────────────────────────────────────────────────────────

const PHASES = {

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
        checkAbsent: true,
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

  "cli-tools": {
    title: "drop CLI Tools dashboard + api, MCP stdio bridge, Cursor/Claude combo presets",
    delete: [
      "src/app/api/cli-tools",
      "src/app/(dashboard)/dashboard/cli-tools",
      "src/app/(dashboard)/dashboard/mitm",
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
        file: "src/shared/services/initializeApp.js",
        find: `import { killAllBridges } from "@/lib/mcp/stdioSseBridge";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/services/initializeApp.js",
        find: `        try { killAllBridges(); } catch { /* best effort */ }
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

  "usage-quota": {
    title: "drop usage tracking + quota tracker + auto-ping (stub the chat-path hooks)",
    delete: [
      "src/app/(dashboard)/dashboard/usage",
      "src/app/(dashboard)/dashboard/quota",
      "src/app/api/usage",
      "src/lib/requestDetailsDb.js",
      "src/lib/db/repos/usageRepo.js",
      "src/lib/db/repos/requestDetailsRepo.js",
      "open-sse/services/usage",
      "open-sse/services/usage.js",
      "open-sse/services/minimaxCodeUsage.js",
      "src/shared/services/quotaAutoPing.js",
      "src/shared/components/UsageStats.js",
      "src/shared/components/RequestLogger.js",
      "src/sse/services/antigravityQuota.js",
    ],
    deps: { remove: ["recharts", "@xyflow/react"] },
    patch: [
      {
        file: "src/lib/db/index.js",
        find: `// Usage
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders,
} from "./repos/requestDetailsRepo.js";

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/lib/usageDb.js",
        writeFile: `// Stub: usage tracking removed in this fork (see scripts/lean.mjs).
// The chat core still calls these hooks, so they stay as no-ops rather than
// forcing edits across the hot request path.
export const statsEmitter = { on() {}, off() {}, emit() {} };
export function trackPendingRequest() {}
export function getActiveRequests() { return []; }
export async function saveRequestUsage() {}
export async function getUsageHistory() { return []; }
export async function getUsageStats() { return {}; }
export async function getChartData() { return {}; }
export async function appendRequestLog() {}
export async function getRecentLogs() { return []; }
export async function saveRequestDetail() {}
export async function getRequestDetails() { return []; }
export async function getRequestDetailById() { return null; }
`,
        check: "usage tracking removed in this fork",
      },
      {
        file: "open-sse/handlers/chatCore/requestDetail.js",
        find: `import { saveRequestUsage, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "open-sse/handlers/chatCore/requestDetail.js",
        find: `import { canonicalizeUsage } from "../../utils/usageTracking.js";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "open-sse/handlers/chatCore/requestDetail.js",
        find: `
  // Canonicalize to one storage convention (prompt_tokens cache-inclusive) so
  // cached/cache-creation tokens survive to cost calc + stats. See canonicalizeUsage.
  const normalized = canonicalizeUsage(tokens) || {
    prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0
  };

  saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: normalized,
    timestamp: new Date().toISOString(),
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null
  }).catch(() => {});
}`,
        replace: `
}`,
        checkAbsent: true,
      },
      {
        file: "src/shared/components/index.js",
        find: `export { default as RequestLogger } from "./RequestLogger";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/services/initializeApp.js",
        find: `  if (hasQuotaAutoPingEnabled(settings)) {
    import("@/shared/services/quotaAutoPing")
      .then(({ startQuotaAutoPing }) => startQuotaAutoPing())
      .catch((e) => console.log("[AutoPing] scheduler start failed:", e.message));
  }

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/services/initializeApp.js",
        find: `// Cheap local check: keeps the scheduler module (and its provider graph) unloaded
// when nothing opted in. An enabled schedule counts on its own.
function hasQuotaAutoPingEnabled(settings) {
  return [settings?.claudeAutoPing, settings?.codexAutoPing].some((config) => (
    Object.values(config?.connections || {}).some(Boolean)
    || Object.values(config?.schedules || {}).some((schedule) => schedule?.enabled === true)
  ));
}

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/api/settings/route.js",
        find: `    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/dashboardGuard.js",
        find: `  "/api/usage",
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `  { href: "/dashboard/usage", label: "Usage", icon: "bar_chart" },
  { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage" },
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Header.js",
        find: `  if (pathname.includes("/usage"))
    return {
      title: "Usage & Analytics",
      description:
        "Monitor your API usage, token consumption, and request logs",
      icon: "bar_chart",
      breadcrumbs: [],
    };
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Header.js",
        find: `  if (pathname.includes("/quota"))
    return {
      title: "Quota Tracker",
      description: "Track and manage your API quota limits",
      icon: "data_usage",
      breadcrumbs: [],
    };
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/layouts/DashboardLayout.js",
        find: `  // Preload heavy usage charts in background when browser is idle
  useEffect(() => {
    const preload = () => {
      import("@/shared/components/UsageStats").catch(() => {});
      import("@/app/(dashboard)/dashboard/usage/components/UsageChart").catch(() => {});
      import("@/app/(dashboard)/dashboard/usage/components/ProviderBarChart").catch(() => {});
      import("@/app/(dashboard)/dashboard/usage/components/TopModelsChart").catch(() => {});
    };
    if (typeof window !== "undefined") {
      if ("requestIdleCallback" in window) {
        const id = window.requestIdleCallback(preload, { timeout: 4000 });
        return () => window.cancelIdleCallback(id);
      }
      const timer = setTimeout(preload, 2500);
      return () => clearTimeout(timer);
    }
  }, []);

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/sse/services/auth.js",
        find: `import { getAntigravityQuotaCache, getAntigravityModelQuota } from "./antigravityQuota.js";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/sse/services/auth.js",
        find: `
    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/sse/services/auth.js",
        find: `      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const connQuotas = antigravityQuotaCache.get(c.id);
        const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", \`\${account} | CACHE_BLOCK \${model} — skip upstream until \${quota.resetAt}\`);
          return false;
        }
      }
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/sse/services/auth.js",
        find: `      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const connQuotas = antigravityQuotaCache.get(c.id);
          const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
          const resetAt = quota?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;`,
        replace: `      // Find earliest persistent lock for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      const earliest = expiries.sort()[0] || null;`,
        check: `// Find earliest persistent lock for retry timing.`,
      },
      {
        file: "src/sse/handlers/chat.js",
        find: `import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/sse/handlers/chat.js",
        find: `        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/sse/handlers/chat.js",
        find: `    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;`,
        replace: `    const resetsAtMs = result.resetsAtMs;
    const shouldFallback = (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;`,
        check: `const shouldFallback = (await markAccountUnavailable(`,
      },
    ],
  },

  "token-saver": {
    title: "drop token savers (rtk, headroom, caveman, ponytail, pxpipe)",
    delete: [
      "open-sse/rtk",
      "src/app/(dashboard)/dashboard/token-saver",
      "src/app/(dashboard)/dashboard/pxpipe",
      "src/app/api/pxpipe",
      "src/lib/pxpipe",
      "src/app/api/headroom",
      "src/lib/headroom",
      "src/app/(dashboard)/dashboard/endpoint/endpointConstants.js",
    ],
    patch: [
      {
        file: "open-sse/handlers/chatCore.js",
        find: `import { injectCaveman } from "../rtk/caveman.js";
import { injectPonytail } from "../rtk/ponytail.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";
import { compressWithHeadroom, formatHeadroomLog, formatHeadroomSizeLog, isHeadroomPhantomSavings } from "../rtk/headroom.js";
import { compressWithPxpipe } from "../rtk/pxpipe.js";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "open-sse/handlers/chatCore.js",
        find: `apiKey, ccFilterNaming, rtkEnabled, headroomEnabled, headroomUrl, headroomCompressUserMessages, headroomTimeoutMs, cavemanEnabled, cavemanLevel, ponytailEnabled, ponytailLevel, pxpipeEnabled, pxpipeMinChars, pxpipeTimeoutMs, pxpipeTransform, onPxpipeEvent, sourceFormatOverride,`,
        replace: `apiKey, ccFilterNaming, sourceFormatOverride,`,
        check: `apiKey, ccFilterNaming, sourceFormatOverride,`,
      },
      {
        file: "open-sse/handlers/chatCore.js",
        find: `  // Per-request opt-out: client can bypass all token savers via header
  const tokenSaverEnabled = clientRawRequest?.headers?.[TOKEN_SAVER_HEADER]?.toLowerCase() !== "off";

  // Cursor's translator rewrites tool_result into user text, so RTK must run on
  // the source body before translation. Every other pair translates the tool
  // shapes 1:1 — keep the post-translate pass there so those providers are
  // untouched (and a retry never re-compresses an already-compressed body).
  const preTranslateRtk = provider === "cursor"
    ? compressMessages(body, tokenSaverEnabled && rtkEnabled)
    : null;
  const preTranslateRtkLine = formatRtkLog(preTranslateRtk);
  if (preTranslateRtkLine) console.log(preTranslateRtkLine);

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "open-sse/handlers/chatCore.js",
        find: `  // RTK: compress tool_result content. Skipped when already done pre-translate.
  const rtkStats = preTranslateRtk || compressMessages(translatedBody, tokenSaverEnabled && rtkEnabled);

  // Headroom: optional external proxy compression; fail open if proxy is absent.
  const headroomDiagnostics = {};
  const headroomStats = await compressWithHeadroom(translatedBody, { enabled: tokenSaverEnabled && headroomEnabled, url: headroomUrl, model: upstreamModel, format: finalFormat, compressUserMessages: headroomCompressUserMessages, timeoutMs: headroomTimeoutMs, diagnostics: headroomDiagnostics });
  const headroomLine = formatHeadroomLog(headroomStats);
  const headroomSizeLine = formatHeadroomSizeLog(headroomDiagnostics);
  if (headroomLine) {
    log?.info?.("HEADROOM", \`\${headroomLine}\${headroomSizeLine ? \` | \${headroomSizeLine}\` : ""}\`);
    if (isHeadroomPhantomSavings(headroomStats, headroomDiagnostics)) {
      log?.warn?.("HEADROOM", \`reported token delta, but messages and outbound JSON shrank <5% | \${formatHeadroomSizeLog(headroomDiagnostics)}\`);
    }
  } else if (tokenSaverEnabled && headroomEnabled) log?.warn?.("HEADROOM", \`skipped: \${headroomDiagnostics.reason || "compression unavailable"}\${headroomDiagnostics.endpoint ? \` (\${headroomDiagnostics.endpoint})\` : ""}\`);

  // Token-saver flags accumulator for the single "⚙" log line below.
  const xf = [];

  if (rtkStats?.hits?.length) xf.push(\`RTK:\${rtkStats.hits.length}\`);

  // Caveman: inject terse-style system prompt
  if (tokenSaverEnabled && cavemanEnabled && cavemanLevel) {
    injectCaveman(translatedBody, finalFormat, cavemanLevel);
    xf.push(\`CAVEMAN:\${cavemanLevel}\`);
  }

  // Ponytail: inject lazy-senior-dev system prompt
  if (tokenSaverEnabled && ponytailEnabled && ponytailLevel) {
    injectPonytail(translatedBody, finalFormat, ponytailLevel);
    xf.push(\`PONYTAIL:\${ponytailLevel}\`);
  }

  // PXPIPE: image bulky context (Claude-format bodies only), last saver before dispatch
  let pxpipeSummary = null;
  if (pxpipeEnabled) {
    const pxpipeResult = await compressWithPxpipe(translatedBody, {
      enabled: true, format: finalFormat, model: upstreamModel,
      minChars: pxpipeMinChars, timeoutMs: pxpipeTimeoutMs, transform: pxpipeTransform,
    });
    pxpipeSummary = pxpipeResult.summary;
    if (pxpipeResult.body) translatedBody = pxpipeResult.body;
    if (pxpipeSummary?.applied) xf.push(\`PXPIPE:\${pxpipeSummary.imageCount}img\`);
    try { onPxpipeEvent?.({ provider, model, ...pxpipeSummary }); } catch { /* stats must not break requests */ }
  }

  if (xf.length && log?.line) log.line(reqTag, "⚙", xf.join(" · "));

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "open-sse/handlers/chatCore.js",
        find: `      pxpipe: pxpipeSummary,
`,
        replace: "",
        allowMultiple: true,
        checkAbsent: true,
      },
      {
        file: "open-sse/handlers/chatCore.js",
        find: `  const sharedCtx = { provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, pxpipe: pxpipeSummary, reqTag, log };`,
        replace: `  const sharedCtx = { provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqTag, log };`,
        check: `const sharedCtx = {`,
      },
      {
        file: "src/sse/handlers/chat.js",
        find: `import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/sse/handlers/chat.js",
        find: `      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/lib/db/repos/settingsRepo.js",
        find: `const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/lib/db/repos/settingsRepo.js",
        find: `  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  headroomTimeoutMs: 3000,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/dashboardGuard.js",
        find: `  "/api/headroom/start",
  "/api/headroom/stop",
  "/api/headroom/proxy",
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `  { href: "/dashboard/token-saver", label: "Token Saver", icon: "savings" },
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Header.js",
        find: `  if (pathname.includes("/token-saver"))
    return {
      title: "Token Saver",
      description: "Compress prompts and outputs to save tokens",
      icon: "savings",
      breadcrumbs: [],
    };
`,
        replace: "",
        checkAbsent: true,
      },
    ],
  },

  sso: {
    title: "drop OIDC/SAML sign-in (password-only dashboard login)",
    delete: [
      "src/app/api/auth/oidc",
      "src/app/api/auth/saml",
      "src/lib/auth/oidc.js",
      "src/lib/auth/saml.js",
    ],
    deps: { remove: ["@node-saml/node-saml"] },
    patch: [
      {
        file: "src/app/api/auth/login/route.js",
        find: `import { isOidcConfigured } from "@/lib/auth/oidc";
import { isSamlConfigured } from "@/lib/auth/saml.js";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/api/auth/login/route.js",
        find: `    if (settings.authMode === "sso" || settings.authMode === "saml" || settings.authMode === "oidc") {
      const ssoType = settings.ssoType || (settings.authMode === "saml" ? "saml" : "oidc");
      if (ssoType === "saml" && isSamlConfigured(settings)) {
        return NextResponse.json({ error: "Password login is disabled. Use SAML SSO sign in." }, { status: 403 });
      }
      if (ssoType === "oidc" && isOidcConfigured(settings)) {
        return NextResponse.json({ error: "Password login is disabled. Use OIDC sign in." }, { status: 403 });
      }
    }

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/api/auth/status/route.js",
        writeFile: `import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";

// Password-only dashboard auth (OIDC/SAML were removed in this fork).
export async function GET() {
  try {
    const settings = await getSettings();
    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    return NextResponse.json({
      requireLogin: settings.requireLogin !== false,
      authMode: "password",
      hasPassword: !!settings.password,
      authenticated: !!session,
    });
  } catch {
    return NextResponse.json({
      requireLogin: true,
      authMode: "password",
      hasPassword: false,
      authenticated: false,
    });
  }
}
`,
        check: "Password-only dashboard auth",
      },
      {
        file: "src/app/api/settings/route.js",
        find: `const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);`,
        replace: `const { password, ...safeSettings } = settings;`,
        allowMultiple: true,
        check: `const { password, ...safeSettings } = settings;`,
      },
      {
        file: "src/app/api/settings/route.js",
        find: `    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/dashboardGuard.js",
        find: `  "/api/auth/oidc",
  "/api/auth/saml",
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/login/page.js",
        find: `  const [authMode, setAuthMode] = useState("password");
  const [ssoType, setSsoType] = useState("oidc");
  const [oidcConfigured, setOidcConfigured] = useState(false);
  const [oidcLoginLabel, setOidcLoginLabel] = useState("Sign in with OIDC");
  const [samlConfigured, setSamlConfigured] = useState(false);
  const [samlLoginLabel, setSamlLoginLabel] = useState("Sign in with SAML SSO");
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/login/page.js",
        find: `          setHasPassword(!!data.hasPassword);
          setAuthMode(data.authMode || "password");
          setSsoType(data.ssoType || "oidc");
          setOidcConfigured(data.oidcConfigured === true);
          setOidcLoginLabel(data.oidcLoginLabel || "Sign in with OIDC");
          setSamlConfigured(data.samlConfigured === true);
          setSamlLoginLabel(data.samlLoginLabel || "Sign in with SAML SSO");`,
        replace: `          setHasPassword(!!data.hasPassword);`,
        check: `setHasPassword(!!data.hasPassword);`,
      },
      {
        file: "src/app/login/page.js",
        find: `  const handleOidcLogin = () => {
    window.location.href = "/api/auth/oidc/start";
  };

  const handleSamlLogin = () => {
    window.location.href = "/api/auth/saml/start";
  };

  const isSsoEnabled = ["sso", "oidc", "saml", "both"].includes(authMode);
  const activeSsoType = ssoType || (authMode === "saml" ? "saml" : "oidc");

  const samlAvailable = isSsoEnabled && activeSsoType === "saml" && samlConfigured;
  const oidcAvailable = isSsoEnabled && activeSsoType === "oidc" && oidcConfigured;
  const ssoAvailable = samlAvailable || oidcAvailable;

  const passwordAvailable = authMode === "password" || authMode === "both" || !ssoAvailable;

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/login/page.js",
        find: `          <p className="text-text-muted">
            {samlAvailable
              ? "Sign in with SAML 2.0 Single Sign-On"
              : oidcAvailable
              ? "Sign in with your OIDC provider to access the dashboard"
              : "Enter your password to access the dashboard"}
          </p>`,
        replace: `          <p className="text-text-muted">Enter your password to access the dashboard</p>`,
        check: `Enter your password to access the dashboard</p>`,
      },
      {
        file: "src/app/login/page.js",
        find: `            {samlAvailable && (
              <Button type="button" variant="primary" className="w-full" onClick={handleSamlLogin}>
                {samlLoginLabel}
              </Button>
            )}

            {oidcAvailable && (
              <Button type="button" variant="primary" className="w-full" onClick={handleOidcLogin}>
                {oidcLoginLabel}
              </Button>
            )}

            {ssoAvailable && passwordAvailable && <div className="h-px bg-border/60" />}

            {passwordAvailable ? (
              <form onSubmit={handleLogin} className="flex flex-col gap-4">
                {isSsoEnabled && !ssoAvailable && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 text-center">
                    {activeSsoType === "saml" ? "SAML SSO" : "OIDC"} login is enabled, but configuration is incomplete. Password login is still available for recovery.
                  </p>
                )}

                {authMode === "both" && ssoAvailable && (
                  <p className="text-xs text-text-muted text-center">
                    Password and {activeSsoType === "saml" ? "SAML SSO" : "OIDC"} login are both enabled.
                  </p>
                )}
`,
        replace: `            <form onSubmit={handleLogin} className="flex flex-col gap-4">
`,
        checkAbsent: true,
      },
      {
        file: "src/app/login/page.js",
        find: `              </form>
            ) : (
              error && <p className="text-xs text-red-500">{error}</p>
            )}
`,
        replace: `              </form>
`,
        checkAbsent: true,
      },
      {
        file: "src/app/login/page.js",
        find: `                    autoFocus={!oidcAvailable}
`,
        replace: `                    autoFocus
`,
        checkAbsent: true,
      },
      {
        file: "src/app/(dashboard)/dashboard/profile/page.js",
        find: `  const [oidcForm, setOidcForm] = useState({`,
        cutTo: `  const importFileRef = useRef(null);`,
      },
      {
        file: "src/app/(dashboard)/dashboard/profile/page.js",
        find: `        setSettings(data);
        setOidcForm({
          authMode: data?.authMode || "password",
          oidcIssuerUrl: data?.oidcIssuerUrl || "",
          oidcClientId: data?.oidcClientId || "",
          oidcScopes: data?.oidcScopes || "openid profile email",
          oidcLoginLabel: data?.oidcLoginLabel || "Sign in with OIDC",
        });
        setOidcClientSecret("");
        setSsoTypeTab(data?.ssoType || "saml");
        setSamlForm({
          samlEntryPoint: data?.samlEntryPoint || "",
          samlIssuer: data?.samlIssuer || "urn:9router:sp",
          samlCert: data?.samlCert || "",
          samlLoginLabel: data?.samlLoginLabel || "Sign in with SAML SSO",
          samlAttributeEmail: data?.samlAttributeEmail || "email",
          samlAttributeName: data?.samlAttributeName || "name",
        });
        if (
          data?.authMode === "sso" ||
          data?.authMode === "saml" ||
          data?.authMode === "oidc" ||
          data?.authMode === "both"
        ) {
          setOidcExpanded(true);
        }`,
        replace: `        setSettings(data);`,
        checkAbsent: true,
      },
      {
        file: "src/app/(dashboard)/dashboard/profile/page.js",
        find: `  const updateOidcForm = (field, value) => {`,
        cutTo: `  const updateObservabilityEnabled = async (enabled) => {`,
      },
      {
        file: "src/app/(dashboard)/dashboard/profile/page.js",
        find: `        {/* Single Sign-On (SSO) */}`,
        cutTo: `        {/* Routing Preferences */}`,
      },
      {
        file: "src/shared/components/Header.js",
        find: `  const [displayName, setDisplayName] = useState("");
  const [loginMethod, setLoginMethod] = useState("");
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Header.js",
        find: `  useEffect(() => {
    let cancelled = false;

    async function loadAuthStatus() {
      try {
        const res = await fetch("/api/auth/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setDisplayName(data?.displayName || data?.samlName || data?.samlEmail || data?.oidcName || data?.oidcEmail || "");
          setLoginMethod(data?.loginMethod || "");
        }
      } catch {
        if (!cancelled) {
          setDisplayName("");
          setLoginMethod("");
        }
      }
    }

    loadAuthStatus();
    return () => {
      cancelled = true;
    };
  }, []);

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Header.js",
        find: `        {displayName && (loginMethod === "OIDC" || loginMethod === "SAML") && (
          <div
            className="hidden sm:flex items-center max-w-[220px] px-3 py-1.5 rounded-full border border-border bg-surface/70 text-xs text-text-muted truncate"
            title={displayName}
          >
            <span className="material-symbols-outlined text-[14px] mr-1.5 text-primary">person</span>
            <span className="truncate">{displayName}</span>
            <span className="ml-2 shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              {loginMethod}
            </span>
          </div>
        )}
`,
        replace: "",
        checkAbsent: true,
      },
    ],
  },

  "mitm-tunnel": {
    title: "drop MITM proxy + Cloudflare tunnel + Tailscale, slim the boot service",
    delete: [
      "src/mitm",
      "src/lib/mitmAliasCache.js",
      "src/lib/tunnel",
      "src/app/api/tunnel",
      "src/app/(dashboard)/dashboard/endpoint/endpointPing.js",
    ],
    patch: [
      {
        file: "src/shared/services/initializeApp.js",
        writeFile: `// Minimal boot service. The fork has no tunnel, Tailscale or MITM to resume,
// so the only deferred work left is connection housekeeping — and the OAuth
// token-refresh scheduler was part of the provider prune (see scripts/lean.mjs).
import { cleanupProviderConnections } from "@/lib/localDb";

const STARTUP_DEFER_MS = 3000;

// Survive Next.js hot reload
const g = (global.__appSingleton ??= { booted: false });

export async function initializeApp() {
  try {
    if (g.booted) return;
    g.booted = true;
    // Defer the work — nothing here blocks incoming requests.
    setTimeout(() => {
      cleanupProviderConnections().catch((e) =>
        console.error("[InitApp] deferred startup failed:", e.message)
      );
    }, STARTUP_DEFER_MS);
  } catch (error) {
    console.error("[InitApp] Error:", error);
  }
}

export default initializeApp;
`,
        check: "Minimal boot service",
      },
      {
        file: "src/shared/components/Header.js",
        find: `  if (pathname.includes("/mitm"))
    return {
      title: "MITM Proxy",
      description: "Intercept CLI tool traffic and route through 9Router",
      icon: "security",
      breadcrumbs: [],
    };
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/dashboardGuard.js",
        find: `  "/api/tunnel",
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/dashboardGuard.js",
        find: `  "/api/tunnel/tailscale-install",
  "/api/tunnel/tailscale-enable",
  "/api/tunnel/tailscale-disable",
  "/api/tunnel/tailscale-check",
  "/api/tunnel/enable",
  "/api/tunnel/disable",
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/dashboardGuard.js",
        find: `    let requireLogin = true;
    let tunnelDashboardAccess = true;

    try {
      const settings = await loadSettings();
      if (settings) {
        requireLogin = settings.requireLogin !== false;
        tunnelDashboardAccess = settings.tunnelDashboardAccess === true;

        // Block tunnel/tailscale access if disabled (redirect to login)
        if (!tunnelDashboardAccess) {
          const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
          const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
          const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
          if ((tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost)) {
            return NextResponse.redirect(new URL("/login", request.url));
          }
        }
      }
    } catch {
      // On error, keep defaults (require login, block tunnel)
    }`,
        replace: `    let requireLogin = true;

    try {
      const settings = await loadSettings();
      if (settings) {
        requireLogin = settings.requireLogin !== false;
      }
    } catch {
      // On error, keep the default (require login)
    }`,
        checkAbsent: true,
      },
      {
        file: "src/app/api/settings/route.js",
        find: `const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];`,
        replace: `const PROTECTED_SETTING_KEYS = ["password"];`,
        check: `const PROTECTED_SETTING_KEYS = ["password"];`,
      },
      {
        file: "src/lib/db/repos/settingsRepo.js",
        find: `const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/lib/db/repos/settingsRepo.js",
        find: `  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/lib/db/repos/settingsRepo.js",
        find: `  tunnelDashboardAccess: true,
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/lib/db/repos/settingsRepo.js",
        find: `  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js",
        find: ` const [tunnelDashboardAccess, setTunnelDashboardAccess] = useState(false);`,
        cutTo: `  const [visibleKeys, setVisibleKeys] = useState(new Set());`,
      },
      {
        file: "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js",
        find: `  // Security gate: block remote exposure while dashboard uses default password or login is off.`,
        cutTo: `  const loadSettings = async () => {`,
      },
      {
        file: "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js",
        find: `  const loadSettings = async () => {
    setTunnelChecking(true);
    try {
      const [settingsData, statusRes] = await Promise.all([
        useSettingsStore.getState().fetchSettings(),
        fetch("/api/tunnel/status", { cache: "no-store" })
      ]);
      if (settingsData) {
        setRequireApiKey(settingsData.requireApiKey || false);
        setRequireLogin(settingsData.requireLogin !== false);
        setHasPassword(settingsData.hasPassword || false);
        setTunnelDashboardAccess(settingsData.tunnelDashboardAccess || false);
      }
      if (statusRes.ok) {
        const data = await statusRes.json();
        const tEnabled = data.tunnel?.settingsEnabled ?? data.tunnel?.enabled ?? false;
        const tUrl = data.tunnel?.tunnelUrl || "";
        setTunnelUrl(tUrl);
        setTunnelPublicUrl(data.tunnel?.publicUrl || "");
        setTunnelEnabled(tEnabled);
        updateReachable(null, tunnelClientReachableRef, tunnelMissRef, setTunnelReachable, tunnelEverReachableRef, setTunnelEverReachable);

        const tsEn = data.tailscale?.settingsEnabled ?? data.tailscale?.enabled ?? false;
        const tsUrlVal = data.tailscale?.tunnelUrl || "";
        setTsUrl(tsUrlVal);
        setTsEnabled(tsEn);
        updateReachable(null, tsClientReachableRef, tsMissRef, setTsReachable, tsEverReachableRef, setTsEverReachable);
      }
    } catch (error) {
      console.log("Error loading settings:", error);
    } finally {
      setTunnelChecking(false);
    }
  };`,
        replace: `  const loadSettings = async () => {
    try {
      const settingsData = await useSettingsStore.getState().fetchSettings();
      if (settingsData) {
        setRequireApiKey(settingsData.requireApiKey || false);
        setRequireLogin(settingsData.requireLogin !== false);
        setHasPassword(settingsData.hasPassword || false);
      }
    } catch (error) {
      console.log("Error loading settings:", error);
    }
  };`,
        checkAbsent: true,
      },
      {
        file: "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js",
        find: `  const handleTunnelDashboardAccess = async (value) => {`,
        cutTo: `  const handleRequireApiKey = async (value) => {`,
      },
      {
        file: "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js",
        find: `const pingTunnelHealth = async (...urls) => {`,
        cutTo: `  const handleCreateKey = async () => {`,
      },
      {
        file: "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js",
        find: `{/* Cloudflare Tunnel */}`,
        cutTo: `        </div>

        {/* Pre-enable security gate banner */}`,
      },
      {
        file: "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js",
        find: `{/* Pre-enable security gate banner */}`,
        cutTo: `      </Card>`,
      },
      {
        file: "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js",
        find: `      {/* Enable Tunnel Modal */}`,
        cutTo: `      {/* Confirm Modal */}`,
      },
      {
        file: "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js",
        find: `import {
  TUNNEL_BENEFITS,
  TUNNEL_PING_INTERVAL_MS,
  TUNNEL_PING_MAX_MS,
  STATUS_POLL_FAST_MS,
  REACHABLE_MISS_THRESHOLD,
  CLIENT_PING_FAST_MS,
} from "./endpointConstants";
import { clientPingUrl, clientPingAny } from "./endpointPing";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js",
        find: `import { useState, useEffect, useRef, useCallback } from "react";`,
        replace: `import { useState, useEffect, useRef } from "react";`,
        check: `import { useState, useEffect, useRef } from "react";`,
      },
      {
        file: "src/app/api/settings/require-login/route.js",
        find: `    const requireLogin = settings.requireLogin !== false;
    const tunnelDashboardAccess = settings.tunnelDashboardAccess !== false;
    const tunnelUrl = settings.tunnelUrl || "";
    const tailscaleUrl = settings.tailscaleUrl || "";
    return NextResponse.json({ requireLogin, tunnelDashboardAccess, tunnelUrl, tailscaleUrl });`,
        replace: `    const requireLogin = settings.requireLogin !== false;
    return NextResponse.json({ requireLogin });`,
        check: `return NextResponse.json({ requireLogin });`,
      },
      {
        file: "src/app/api/auth/login/route.js",
        find: `function isTunnelRequest(request, settings) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
  const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
  return (tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost);
}

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/api/auth/login/route.js",
        find: `    // Block login via tunnel/tailscale if dashboard access is disabled
    if (isTunnelRequest(request, settings) && settings.tunnelDashboardAccess !== true) {
      return NextResponse.json({ error: "Dashboard access via tunnel is disabled" }, { status: 403 });
    }

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/layout.js",
        find: `import "@/shared/services/bootstrap"; // Auto-run initializeApp (watchdog, auto-resume tunnel)`,
        replace: `import "@/shared/services/bootstrap"; // Auto-run initializeApp (deferred housekeeping)`,
        check: `deferred housekeeping`,
      },
      {
        file: "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js",
        find: `import StatusAlert from "./components/StatusAlert";
import Tooltip from "./components/Tooltip";
`,
        replace: "",
        checkAbsent: true,
      },
    ],
  },

  providers: {
    title: "keep only OpenCode Free (prune registry, executors, OAuth flows)",
    pruneDir: [
      { dir: "open-sse/providers/registry", keep: ["index.js", "opencode.js"] },
      { dir: "open-sse/executors", keep: ["index.js", "opencode.js", "default.js", "base.js"] },
    ],
    delete: [
      "src/lib/oauth/providers",
      "src/lib/oauth/providers.js",
      "src/lib/oauth/services",
      "src/lib/oauth/kiroExternalIdp.js",
      "src/lib/oauth/utils",
      "src/lib/mimoLoginSession.js",
      "src/app/api/oauth",
      "src/app/callback",
      "src/app/api/providers/kilo",
      "src/app/api/providers/suggested-models",
      "src/shared/components/OAuthModal.js",
      "src/shared/components/KiroOAuthWrapper.js",
      "src/shared/components/KiroSocialOAuthModal.js",
      "src/shared/components/CursorAuthModal.js",
      "src/shared/components/ZedAuthModal.js",
      "src/shared/components/XiaomiMimoAuthModal.js",
      "src/shared/components/IFlowCookieModal.js",
      "src/shared/components/GitLabAuthModal.js",
      "src/shared/components/KiroAuthModal.js",
      "src/sse/services/backgroundTokenRefresh.js",
    ],
    patch: [
      {
        file: "open-sse/providers/registry/index.js",
        writeFile: `// Lean fork: only the OpenCode Free provider is bundled (see scripts/lean.mjs).
// Upstream's file is auto-generated from registry/*.js — when a provider is
// restored, add its import here (and its file) or run the strip script again.
import p0 from "./opencode.js";

const REGISTRY = [p0];

export default REGISTRY;
`,
        check: "only the OpenCode Free provider is bundled",
      },
      {
        file: "open-sse/executors/index.js",
        writeFile: `// Lean fork: OpenCode Free + the generic OpenAI/Anthropic-compatible executor
// (see scripts/lean.mjs). getExecutor() falls back to DefaultExecutor.
import { OpenCodeExecutor } from "./opencode.js";
import { DefaultExecutor } from "./default.js";

const executors = {
  opencode: new OpenCodeExecutor(),
};

const defaultCache = new Map();

export function getExecutor(provider) {
  if (executors[provider]) return executors[provider];
  if (!defaultCache.has(provider)) defaultCache.set(provider, new DefaultExecutor(provider));
  return defaultCache.get(provider);
}

export function hasSpecializedExecutor(provider) {
  return !!executors[provider];
}

export { BaseExecutor } from "./base.js";
export { DefaultExecutor } from "./default.js";
export { OpenCodeExecutor } from "./opencode.js";
`,
        check: "OpenCode Free + the generic OpenAI/Anthropic-compatible executor",
      },
      {
        file: "open-sse/services/tokenRefresh/providers.js",
        find: `import { buildExternalIdpRefreshParams } from "../../../src/lib/oauth/kiroExternalIdp.js";
`,
        replace: `// Lean fork: the Kiro external-IdP flow went away with the OAuth providers.
function buildExternalIdpRefreshParams() {
  return null;
}
`,
        check: `function buildExternalIdpRefreshParams() {`,
      },
      {
        file: "open-sse/services/tokenRefresh/providers.js",
        find: `let _xaiServiceSingleton = null;
export async function refreshXaiToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("xai", refreshToken, async () => {
    try {
      if (!_xaiServiceSingleton) {
        const mod = await import("../../../src/lib/oauth/services/xai.js");
        _xaiServiceSingleton = new mod.XaiService();
      }
      const tokens = await _xaiServiceSingleton.refreshAccessToken(refreshToken);
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        expiresIn: tokens.expires_in,
        idToken: tokens.id_token,
      };
    } catch (e) {
      log?.warn?.("TOKEN_REFRESH", \`xai refresh failed: \${e?.message || e}\`);
      const msg = String(e?.message || "");
      if (msg.includes("invalid_grant") || msg.includes("invalid_request")) {
        return { error: "invalid_grant" };
      }
      return null;
    }
  }, log);
}`,
        replace: `// Lean fork: the xAI / grok-cli refresh lived in the OAuth service layer that
// was removed with the other providers. Kept as a nullable stub so the refresh
// profile map below stays intact.
export async function refreshXaiToken() {
  return null;
}`,
        check: `Kept as a nullable stub`,
      },
      {
        file: "open-sse/services/tokenRefresh/providers.js",
        find: `    const { fetchKiroProfileArn } = await import("../../../src/lib/oauth/providers.js");
    profileArn = await fetchKiroProfileArn(accessToken);
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/api/providers/client/route.js",
        find: `import { backfillCodexEmails } from "@/lib/oauth/providers";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/api/providers/client/route.js",
        find: `    await backfillCodexEmails();

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/(dashboard)/dashboard/providers/[id]/page.js",
        find: `import { Card, Button, Badge, Input, Modal, CardSkeleton, OAuthModal, KiroOAuthWrapper, CursorAuthModal, ZedAuthModal, XiaomiMimoAuthModal, IFlowCookieModal, GitLabAuthModal, Toggle, Select, EditConnectionModal, NoAuthProxyCard, ConfirmModal } from "@/shared/components";`,
        replace: `import { Card, Button, Modal, CardSkeleton, Toggle, Select, EditConnectionModal, NoAuthProxyCard, ConfirmModal } from "@/shared/components";`,
        check: `NoAuthProxyCard, ConfirmModal } from "@/shared/components";`,
      },
      {
        file: "src/app/(dashboard)/dashboard/providers/[id]/page.js",
        find: `      {/* Modals */}`,
        cutTo: `      <AddApiKeyModal`,
      },
      {
        file: "src/shared/components/index.js",
        find: `export { default as OAuthModal } from "./OAuthModal";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/index.js",
        find: `export { default as KiroAuthModal } from "./KiroAuthModal";
export { default as KiroOAuthWrapper } from "./KiroOAuthWrapper";
export { default as CursorAuthModal } from "./CursorAuthModal";
export { default as ZedAuthModal } from "./ZedAuthModal";
export { default as XiaomiMimoAuthModal } from "./XiaomiMimoAuthModal";
export { default as IFlowCookieModal } from "./IFlowCookieModal";
export { default as GitLabAuthModal } from "./GitLabAuthModal";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/api/providers/validate/route.js",
        find: `import { probeBedrockCredentials } from "open-sse/executors/bedrock.js";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/api/providers/[id]/test/testUtils.js",
        find: `import { probeBedrockCredentials } from "open-sse/executors/bedrock.js";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "open-sse/translator/index.js",
        find: `import { AntigravityExecutor } from "../executors/antigravity.js";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/api/providers/validate/route.js",
        find: `      // AWS-signed providers (Bedrock) have no bearer key for the generic probes below, which
      // would reject bedrock outright and send bedrock-xai to a literal "{region}" host.
      if (AI_PROVIDERS[provider]?.credentialForm === "aws") {
        return NextResponse.json(await probeBedrockCredentials({ apiKey, providerSpecificData }, fetch));
      }

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/api/providers/[id]/test/testUtils.js",
        find: `  // AWS-signed providers (Bedrock): without this every Test ends in the switch's default,
  // "Provider test not supported", and marks a working connection as errored.
  if (AI_PROVIDERS[connection.provider]?.credentialForm === "aws") {
    try {
      return await probeBedrockCredentials(
        connection,
        (url, options) => fetchWithConnectionProxy(url, options, effectiveProxy),
      );
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/api/providers/[id]/models/route.js",
        find: `import codexProvider from "open-sse/providers/registry/codex.js";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/api/providers/[id]/models/route.js",
        find: "const CODEX_MODELS_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${codexProvider.transport.cliVersion}`;",
        replace: "const CODEX_MODELS_URL = \"https://chatgpt.com/backend-api/codex/models\";",
        check: `const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";`,
      },
      {
        file: "custom-server.js",
        find: `let backgroundRefreshStarted = false;

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "custom-server.js",
        find: `  const server = origCreate(...rest, wrapped);
  server.once("listening", () => {
    startBackgroundTokenRefreshFromCustomServer();
  });`,
        replace: `  const server = origCreate(...rest, wrapped);`,
        checkAbsent: true,
      },
      {
        file: "custom-server.js",
        find: `const { pathToFileURL } = require("url");
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/proxy.js",
        writeFile: `import { proxy as dashboardProxy } from "./dashboardGuard";

// Lean fork: the Xiaomi MiMo session-login proxy went away with the OAuth
// providers, so the dashboard auth guard is the only thing left to run.
export default function proxy(request) {
  return dashboardProxy(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\\\.ico).*)"],
};
`,
        check: "the Xiaomi MiMo session-login proxy went away",
      },
    ],
  },

  cosmetics: {
    title: "drop docs/deploy extras, npm CLI, Skills, Translator, pricing, promos, sql.js",
    delete: [
      "gitbook",
      "images",
      "docs",
      "README.zh-CN.md",
      "Dockerfile",
      "docker-compose.yml",
      "captain-definition",
      "start.sh",
      ".dockerignore",
      "DOCKER.md",
      ".github/workflows",
      "cli",
      "skills",
      "src/app/(dashboard)/dashboard/basic-chat",
      "src/app/(dashboard)/dashboard/skills",
      "src/shared/constants/skills.js",
      "src/app/landing",
      "src/app/api/pricing",
      "src/app/dashboard",
      "src/shared/components/PricingModal.js",
      "src/shared/components/NineRemoteButton.js",
      "src/shared/components/NineRemotePromoModal.js",
      "src/shared/components/DonateModal.js",
      "src/app/(dashboard)/dashboard/translator",
      "src/app/api/translator",
      "src/shared/components/ChangelogModal.js",
      "src/lib/db/adapters/sqljsAdapter.js",
    ],
    deps: {
      remove: [
        "@monaco-editor/react",
        "monaco-editor",
        "@next/third-parties",
        "open",
        "marked",
        "sql.js",
        "selfsigned",
        "http-proxy-middleware",
      ],
    },
    patch: [
      {
        file: "src/shared/components/Sidebar.js",
        find: `import { useState, useEffect } from "react";`,
        replace: `import { useState } from "react";`,
        check: `import { useState } from "react";`,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `import useSettingsStore from "@/store/settingsStore";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `  const [enableTranslator, setEnableTranslator] = useState(false);

  useEffect(() => {
    useSettingsStore.getState().fetchSettings().then((data) => {
      if (data?.enableTranslator) setEnableTranslator(true);
    });
  }, []);

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `  { href: "/dashboard/console-log", label: "Console Log", icon: "terminal" },
  { href: "/dashboard/translator", label: "Translator", icon: "translate" },
`,
        replace: `  { href: "/dashboard/console-log", label: "Console Log", icon: "terminal" },
`,
        check: `{ href: "/dashboard/console-log", label: "Console Log", icon: "terminal" },`,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
  { href: "/dashboard/skills", label: "Skills", icon: "extension" },
`,
        replace: `  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
`,
        check: `{ href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },`,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `            {debugItems.map((item) => {
              const show = item.href !== "/dashboard/translator" || enableTranslator;
              return show ? (
                <Link`,
        replace: `            {debugItems.map((item) => (
                <Link`,
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `                </Link>
              ) : null;
            })}
`,
        replace: `                </Link>
            ))}
`,
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `
            {/* Remote */}
            <a
              href="https://9remote.cc"
              target="_blank"
              rel="noreferrer"
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 px-3 py-1 rounded-lg transition-all group w-full",
                "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[18px] group-hover:text-primary transition-colors">
                computer
              </span>
              <span className="text-[13px] font-medium">9Remote</span>
              <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px] bg-orange-500/15 text-orange-400">
                HOT
              </span>
            </a>

            {/* 9English */}
            <a
              href="https://9english.net/"
              target="_blank"
              rel="noreferrer"
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 px-3 py-1 rounded-lg transition-all group w-full",
                "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[18px] group-hover:text-primary transition-colors">
                translate
              </span>
              <span className="text-[13px] font-medium">9English</span>
            </a>
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Header.js",
        find: `import DonateModal from "@/shared/components/DonateModal";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Header.js",
        find: `  const [donateOpen, setDonateOpen] = useState(false);
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Header.js",
        find: `        <button
          onClick={() => setDonateOpen(true)}
          className="hidden sm:flex items-center gap-1.5 px-3 h-8 rounded-lg border border-pink-500/30 bg-pink-500/10 text-pink-600 dark:text-pink-400 hover:bg-pink-500/20 transition-colors text-sm font-medium"
          aria-label="Donate"
        >
          <span className="material-symbols-outlined text-[18px]">volunteer_activism</span>
          <span className="hidden sm:inline">Donate</span>
        </button>
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Header.js",
        find: `      <DonateModal isOpen={donateOpen} onClose={() => setDonateOpen(false)} />
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Header.js",
        find: `  if (pathname.includes("/skills"))
    return {
      title: "Agent Skills",
      description: "Copy a link and paste to your AI to use 9Router — no install needed",
      icon: "extension",
      breadcrumbs: [],
    };
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Header.js",
        find: `  if (pathname.includes("/translator"))
    return {
      title: "Translator",
      description: "Debug translation flow between formats",
      icon: "translate",
      breadcrumbs: [],
    };
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/index.js",
        find: `export { default as NineRemoteButton } from "./NineRemoteButton";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/lib/db/driver.js",
        find: `async function trySqlJs() {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    return await createSqlJsAdapter(DATA_FILE);
  } catch (e) {
    console.warn(\`[DB] sql.js unavailable: \${e.message}\`);
    return null;
  }
}

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/lib/db/driver.js",
        find: `  // Order per runtime:
  //   Bun:  bun:sqlite → sql.js
  //   Node: better-sqlite3 → node:sqlite (≥22.5) → sql.js
  let adapter = await tryBunSqlite();
  if (!adapter) adapter = await tryBetterSqlite();
  if (!adapter) adapter = await tryNodeSqlite();
  if (!adapter) adapter = await trySqlJs();
  if (!adapter) throw new Error("[DB] No SQLite driver available (bun/better/node/sql.js all failed)");`,
        replace: `  // Order per runtime:
  //   Bun:  bun:sqlite
  //   Node: better-sqlite3 → node:sqlite (≥22.5)
  let adapter = await tryBunSqlite();
  if (!adapter) adapter = await tryBetterSqlite();
  if (!adapter) adapter = await tryNodeSqlite();
  if (!adapter) throw new Error("[DB] No SQLite driver available (bun/better/node all failed)");`,
        check: `No SQLite driver available (bun/better/node all failed)`,
      },
      {
        file: "src/app/layout.js",
        find: `import { GoogleAnalytics } from "@next/third-parties/google";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/app/layout.js",
        find: `        <GoogleAnalytics gaId={"G-LC959F603F"} />
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "next.config.mjs",
        find: `optimizePackageImports: ["@xyflow/react", "@dnd-kit/core", "@dnd-kit/sortable", "material-symbols", "marked"],`,
        replace: `optimizePackageImports: ["@dnd-kit/core", "@dnd-kit/sortable", "material-symbols"],`,
        check: `optimizePackageImports: ["@dnd-kit/core", "@dnd-kit/sortable", "material-symbols"],`,
      },
      {
        file: "src/shared/components/HeaderMenu.js",
        find: `import ChangelogModal from "./ChangelogModal";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/HeaderMenu.js",
        find: `  const [changelogOpen, setChangelogOpen] = useState(false);
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/HeaderMenu.js",
        find: `            <MenuItem
              icon="history"
              label="Change Log"
              onClick={() => { close(); setChangelogOpen(true); }}
            />
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/HeaderMenu.js",
        find: `      <ChangelogModal isOpen={changelogOpen} onClose={() => setChangelogOpen(false)} />
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/components/index.js",
        find: `export { default as ChangelogModal } from "./ChangelogModal";
`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "src/shared/constants/config.js",
        find: `// GitHub configuration
export const GITHUB_CONFIG = {
  changelogUrl: "https://raw.githubusercontent.com/decolua/9router/refs/heads/master/CHANGELOG.md",
  donateUrl: "https://9router.com/api/donate",
};

`,
        replace: "",
        checkAbsent: true,
      },
      {
        file: "package.json",
        find: `    "start:bun": "bun ./.next/standalone/custom-server.js",
    "cli:pack": "npm --prefix cli run pack:cli",
    "cli:publish": "npm --prefix cli run publish:cli"`,
        replace: `    "start:bun": "bun ./.next/standalone/custom-server.js"`,
        check: `"start:bun": "bun ./.next/standalone/custom-server.js"`,
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
