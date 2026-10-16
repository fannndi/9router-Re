#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// lean.mjs — fork-slimming tool for fannndi/9router-Re
//
// The fork keeps only what the free-tier multi-IP gateway needs:
//   providers(opencode free) + proxy pools + API keys + vision input.
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
    if (rule.overlay) return "skip";
    // A file deleted by another phase in this run is expected to be gone: the
    // patch that would target it is already resolved. A file nobody deletes
    // and nobody patches is still an error (upstream moved the patch site).
    const deletedByPhases = Object.values(PHASES).some((phase) =>
      (phase?.delete || []).some((rel) => rel === rule.file || rule.file.startsWith(`${rel}/`))
    );
    if (deletedByPhases) return "skip";
    throw new Error(`patch target missing: ${rule.file}`);
  }
  let src = fs.readFileSync(abs, "utf8");

  if (rule.createFrom) {
    // Fork-owned file that must exist even after upstream/earlier phases deleted
    // it (e.g. a route the providers phase pruned but the UI still calls).
    const srcAbs = path.join(ROOT, rule.createFrom);
    if (!fs.existsSync(srcAbs)) {
      throw new Error(`createFrom source missing: ${rule.createFrom}`);
    }
    const content = fs.readFileSync(srcAbs, "utf8");
    const absTarget = path.join(ROOT, rule.file);
    if (fs.existsSync(absTarget) && fs.readFileSync(absTarget, "utf8") === content) return "skip";
    if (!dry) {
      fs.mkdirSync(path.dirname(absTarget), { recursive: true });
      fs.writeFileSync(absTarget, content);
    }
    return "applied";
  }

  if (rule.overlay) {
    // Fork-owned file: replace it wholesale with the lean copy under
    // scripts/lean/overlays/. Skip when upstream deleted the target.
    const overlayAbs = path.join(ROOT, rule.overlay);
    if (!fs.existsSync(overlayAbs)) {
      throw new Error(`overlay source missing: ${rule.overlay}`);
    }
    const content = fs.readFileSync(overlayAbs, "utf8");
    if (src === content) return "skip";
    if (!dry) fs.writeFileSync(abs, content);
    return "applied";
  }

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
  if (!phase.deps?.remove?.length && !phase.deps?.removeComments?.length) return { removed: 0 };
  const pkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  let removed = 0;
  for (const dep of phase.deps.remove || []) {
    if (pkg.dependencies?.[dep]) {
      delete pkg.dependencies[dep];
      removed++;
      if (!quiet) console.log(c.dim(`  - dep ${dep}`));
    }
    if (pkg.optionalDependencies?.[dep]) {
      delete pkg.optionalDependencies[dep];
      removed++;
      if (!quiet) console.log(c.dim(`  - optional dep ${dep}`));
    }
  }
  if (pkg.optionalDependencies && Object.keys(pkg.optionalDependencies).length === 0) {
    delete pkg.optionalDependencies;
  }
  for (const key of phase.deps.removeComments || []) {
    if (pkg[key] !== undefined) {
      delete pkg[key];
      removed++;
      if (!quiet) console.log(c.dim(`  - package.json key ${key}`));
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
      if (rule.overlay || rule.createFrom) return false;
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
      return !!pkg.dependencies?.[dep] || !!pkg.optionalDependencies?.[dep];
    });
    const leftoverOverlays = (phase.patch || []).filter((rule) => {
      if (rule.createFrom) {
        try {
          return !exists(rule.file) || read(rule.file) !== read(rule.createFrom);
        } catch {
          return true;
        }
      }
      if (!rule.overlay) return false;
      if (!exists(rule.file)) return false; // upstream / earlier phase deleted it → resolved
      try {
        return read(rule.file) !== read(rule.overlay);
      } catch {
        return false;
      }
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
    if (leftoverPaths.length || leftoverPatches.length || leftoverDeps.length || leftoverPrunes.length || leftoverOverlays.length) {
      problems++;
      console.log(c.red(`✗ ${id} not fully applied`));
      for (const p of leftoverPaths) console.log(c.red(`    path still present: ${p}`));
      for (const p of leftoverPatches) console.log(c.red(`    patch site still present: ${p.file}`));
      for (const d of leftoverDeps) console.log(c.red(`    dep still present: ${d}`));
      for (const p of leftoverPrunes) console.log(c.red(`    dir entry still present: ${p}`));
      for (const p of leftoverOverlays) console.log(c.red(`    overlay not applied: ${p.file}`));
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
        checkAbsent: true,
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
        checkAbsent: true,
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
        checkAbsent: true,
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
        checkAbsent: true,
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
        file: "src/shared/components/Sidebar.js",
        find: `  // { href: "/dashboard/pxpipe", label: "PXPIPE", icon: "image" },
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
        checkAbsent: true,
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
        find: `  const { copied, copy } = useCopyToClipboard();
`,
        replace: `  const { copied, copy } = useCopyToClipboard();

  // Mount fetch: the tunnel status poll above used to be the only effect here.
  useEffect(() => {
    fetchData();
    loadSettings();
  }, []);
`,
        check: `fetchData();
    loadSettings();`,
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
        file: "open-sse/translator/index.js",
        find: `import { AntigravityExecutor } from "../executors/antigravity.js";
`,
        replace: "",
        checkAbsent: true,
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
        checkAbsent: true,
      },
      {
        file: "src/shared/components/Sidebar.js",
        find: `  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
  { href: "/dashboard/skills", label: "Skills", icon: "extension" },
`,
        replace: `  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
`,
        checkAbsent: true,
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
        checkAbsent: true,
      },
    ],
  },
};

// ─── cli ───────────────────────────────────────────────────────────────────

// ─── sweep (maximal) ───────────────────────────────────────────────────────
// Repo cruft (upstream docs/CI/npm bits), the modules the provider prune left
// behind (vendor resolvers, kiro/cursor/ollama/antigravity translators), the
// relay-deploy feature, the dashboard i18n layer, and every test that covered
// the removed surface. Files whose fork version is a deliberate rewrite live in
// scripts/lean/overlays/ and are copied over verbatim (see applyPatch).
PHASES.sweep = {
  title: "sweep: repo cruft, dead code, vendor dead ends, i18n",
  delete: [
    ".github/dependabot.yml",
    ".github/issue-assets/combo-defaults/cursor-model-list.png",
    ".github/issue-assets/combo-defaults/override-openai-base-url.png",
    ".npmignore",
    "CHANGELOG.md",
    "CLAUDE.md",
    "i18n/README.es.md",
    "i18n/README.fa_IR.md",
    "i18n/README.fr.md",
    "i18n/README.id-ID.md",
    "i18n/README.ja-JP.md",
    "i18n/README.pt-BR.md",
    "i18n/README.ru.md",
    "i18n/README.th.md",
    "i18n/README.vi.md",
    "i18n/README.zh-CN.md",
    "open-sse/config/awsConstants.js",
    "open-sse/config/codexInstructions.js",
    "open-sse/config/constants.js",
    "open-sse/config/googleTtsLanguages.js",
    "open-sse/config/grokCli.js",
    "open-sse/config/kiroConstants.js",
    "open-sse/config/models.js",
    "open-sse/handlers/responsesHandler.js",
    "open-sse/providers/REGISTRY_TEMPLATE.js",
    "open-sse/services/clinepassModels.js",
    "open-sse/services/compact.js",
    "open-sse/services/copilotModels.js",
    "open-sse/services/cursorModels.js",
    "open-sse/services/grokCliModels.js",
    "open-sse/services/kimchiModels.js",
    "open-sse/services/kiroModels.js",
    "open-sse/services/nous.js",
    "open-sse/services/qoderModels.js",
    "open-sse/services/thoughtSignatureStore.js",
    "open-sse/shared/awsCredentials.js",
    "open-sse/shared/clineEnvelope.js",
    "open-sse/shared/machineId.js",
    "open-sse/shared/mimoAccount.js",
    "open-sse/shared/qoder/attachments.js",
    "open-sse/shared/qoder/constants.js",
    "open-sse/shared/qoder/contextTier.js",
    "open-sse/shared/qoder/cosy.js",
    "open-sse/shared/qoder/encoding.js",
    "open-sse/shared/qoder/sse.js",
    "open-sse/shared/zedAuth.js",
    "open-sse/transformer/responsesTransformer.js",
    "open-sse/translator/concerns/kiroConversation.js",
    "open-sse/translator/request/antigravity-to-openai.js",
    "open-sse/translator/request/claude-to-kiro.js",
    "open-sse/translator/request/openai-to-commandcode.js",
    "open-sse/translator/request/openai-to-cursor.js",
    "open-sse/translator/request/openai-to-gemini.js",
    "open-sse/translator/request/openai-to-kiro.js",
    "open-sse/translator/request/openai-to-ollama.js",
    "open-sse/translator/request/openai-to-vertex.js",
    "open-sse/translator/response/commandcode-to-openai.js",
    "open-sse/translator/response/cursor-to-openai.js",
    "open-sse/translator/response/gemini-to-openai.js",
    "open-sse/translator/response/kiro-to-claude.js",
    "open-sse/translator/response/kiro-to-openai.js",
    "open-sse/translator/response/ollama-to-openai.js",
    "open-sse/translator/response/openai-to-antigravity.js",
    "open-sse/utils/awsEventStream.js",
    "open-sse/utils/awsSigv4.js",
    "open-sse/utils/claudeToolTypeSelfCheck.mjs",
    "open-sse/utils/codexToolSchema.js",
    "open-sse/utils/cursorChecksum.js",
    "open-sse/utils/cursorProtobuf.js",
    "open-sse/utils/kiroSessionReplay.js",
    "open-sse/utils/sse.js",
    "public/file.svg",
    "public/globe.svg",
    "public/i18n",
    "public/next.svg",
    "public/sw.js",
    "public/vercel.svg",
    "public/window.svg",
    "scripts/injectDisplayToRegistry.mjs",
    "scripts/migrate-registry.mjs",
    "scripts/test-combo-autoswitch.mjs",
    "scripts/translate-readme.js",
    "src/app/(dashboard)/dashboard/providers/[id]/AutoPingScheduleModal.js",
    "src/app/(dashboard)/dashboard/providers/[id]/BulkImportCodexModal.js",
    "src/app/(dashboard)/dashboard/providers/[id]/BulkImportGrokCliModal.js",
    "src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js",
    "src/app/(dashboard)/dashboard/providers/components/ModelsCard.js",
    "src/app/api/locale/route.js",
    "src/app/api/proxy-pools/cloudflare-deploy/route.js",
    "src/app/api/proxy-pools/deno-deploy/route.js",
    "src/app/api/proxy-pools/netlify-deploy/route.js",
    "src/app/api/proxy-pools/vercel-deploy/route.js",
    "src/i18n/RuntimeI18nProvider.js",
    "src/i18n/config.js",
    "src/i18n/runtime.js",
    "src/lib/grokBuildConfig.js",
    "src/lib/network/netlifyRelay.js",
    "src/lib/oauth/constants/oauth.js",
    "src/lib/oauth/constants/xai.js",
    "src/lib/oauth/providerHelpers.js",
    "src/lib/qoder/constants.js",
    "src/lib/qoder/cosy.js",
    "src/lib/qoder/encoding.js",
    "src/lib/updater/updater.js",
    "src/shared/components/Drawer.js",
    "src/shared/components/HeaderLanguage.js",
    "src/shared/components/LanguageSwitcher.js",
    "src/shared/components/Pagination.js",
    "src/shared/constants/colors.js",
    "src/shared/constants/coworkPlugins.js",
    "src/shared/constants/index.js",
    "src/shared/constants/locales.js",
    "src/shared/constants/mitmToolHosts.js",
    "src/shared/constants/ttsProviders.js",
    "src/shared/hooks/index.js",
    "src/shared/services/quotaPingSchedule.js",
    "src/shared/utils/clineAuth.js",
    "src/store/index.js",
    "src/store/providerStore.js",
    "src/store/userStore.js",
    "tests/__baseline__/alias-baseline.json",
    "tests/__baseline__/baseline-results.json",
    "tests/__baseline__/current.json",
    "tests/__baseline__/known-fails.txt",
    "tests/__baseline__/oauth-urls-baseline.json",
    "tests/__baseline__/providers-baseline.json",
    "tests/__baseline__/snapshot-providers.mjs",
    "tests/__baseline__/verify-alias.mjs",
    "tests/__baseline__/verify-no-regression.mjs",
    "tests/__baseline__/verify-oauth-urls.mjs",
    "tests/__baseline__/verify-providers.mjs",
    "tests/translator/bugs-kiro.test.js",
    "tests/translator/kiro-tool-name-roundtrip.test.js",
    "tests/translator/real/antigravity-models.real.test.js",
    "tests/translator/real/deepseek-official-responses.real.test.js",
    "tests/translator/real/nvidia-thinking.e2e.test.js",
    "tests/translator/real/opencode-go-deepseek.real.test.js",
    "tests/translator/real/opencode-go-thinking-passthrough.real.test.js",
    "tests/translator/real/opencode-go-thinking-placeholder.real.test.js",
    "tests/translator/real/opencode-go-tool-session.real.test.js",
    "tests/unit/antigravity-thought-signature-family.test.js",
    "tests/unit/aws-credentials.test.js",
    "tests/unit/aws-sigv4.test.js",
    "tests/unit/codebuddy-intl-test-config.test.js",
    "tests/unit/gemini-duplicate-tool-call-ids.test.js",
    "tests/unit/grok-build-config.test.js",
    "tests/unit/grok-cli-models.test.js",
    "tests/unit/grok-cli-oauth-probe.test.js",
    "tests/unit/kiro-conversation-canonicalization.test.js",
    "tests/unit/kiro-minimal-wire-payload.test.js",
    "tests/unit/kiro-tool-result-placeholder.test.js",
    "tests/unit/netlify-relay.test.js",
    "tests/unit/nous-provider-routes.test.js",
    "tests/unit/ollama-stream-tail.test.js",
    "tests/unit/openai-to-ollama-malformed.test.js",
    "tests/unit/qoder-context-tier.test.js",
    "tests/unit/quota-ping-schedule.test.js",
    "tests/unit/thinking-levels-kiro.test.js",
    "tests/unit/zed-live-models.test.js",
  ],
  pruneDir: [
    { dir: "public/providers", keep: ["opencode.png", "oai-r.png", "oai-cc.png", "anthropic-m.png"] },
  ],
  deps: {
    remove: ["chalk", "enquirer", "express", "node-forge", "ora", "react-is", "socks-proxy-agent", "@aws-sdk/credential-providers"],
    removeComments: ["comment_aws_sdk_credential_providers"],
  },
  patch: [
    // ── core engine: drop the token-saver header + grok-cli effort probe
    {
      file: "open-sse/handlers/chatCore.js",
      find: `import { HTTP_STATUS, TOKEN_SAVER_HEADER } from "../config/runtimeConfig.js";`,
      replace: `import { HTTP_STATUS } from "../config/runtimeConfig.js";`,
    },
    {
      file: "open-sse/handlers/chatCore.js",
      find: `import { supportsGrokCliReasoningEffort } from "../config/grokCli.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/handlers/chatCore.js",
      find: `    const showThinking = provider !== "grok-cli" || supportsGrokCliReasoningEffort(model);`,
      replace: `    const showThinking = true;`,
    },
    // ── non-streaming handler: drop the ollama target branch + cline envelope
    {
      file: "open-sse/handlers/chatCore/nonStreamingHandler.js",
      find: `import { ollamaBodyToOpenAI } from "../../translator/response/ollama-to-openai.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/handlers/chatCore/nonStreamingHandler.js",
      find: `import { unwrapClineEnvelope } from "../../shared/clineEnvelope.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/handlers/chatCore/nonStreamingHandler.js",
      find: `  // Ollama\n  if (targetFormat === FORMATS.OLLAMA) {\n    return ollamaBodyToOpenAI(responseBody);\n  }\n\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/handlers/chatCore/nonStreamingHandler.js",
      find: `  // Unwrap before any consumer reads choices/usage so non-stream clients get a\n  // bare OpenAI body and usage tracking sees data.usage. No-op unless the\n  // provider opts in via transport.quirks.clineEnvelope.\n  responseBody = unwrapClineEnvelope(responseBody, provider);\n\n`,
      replace: "",
      checkAbsent: true,
    },
    // ── chat handler: drop the antigravity/gemini-cli project-id warm-up
    {
      file: "src/sse/handlers/chat.js",
      find: `import { getProjectIdForConnection } from "open-sse/services/projectId.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `\n    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)\n    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {\n      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);\n      if (pid) {\n        refreshedCredentials.projectId = pid;\n        // Persist to DB in background so subsequent requests have it immediately\n        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });\n      }\n    }\n`,
      replace: "",
      checkAbsent: true,
    },
    // ── noauth proxy payload: relay field is gone
    {
      file: "src/sse/services/auth.js",
      find: `            vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",\n`,
      replace: "",
      checkAbsent: true,
    },
    // ── proxyFetch: drop the relay forwarding branch
    {
      file: "open-sse/utils/proxyFetch.js",
      find: `  // Vercel relay: forward request via relay headers`,
      cutTo: `  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);`,
    },
    // ── connectionProxy: drop the relay pool branch
    {
      file: "src/lib/network/connectionProxy.js",
      find: `        /**\n         * Vercel/Cloudflare/Deno/Netlify relay proxies use base URL rewriting`,
      cutTo: `        /**\n         * Standard proxy pool`,
    },
    // ── proxy pool API: only plain http pools exist now
    {
      file: "src/app/api/proxy-pools/route.js",
      find: `const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno", "netlify"];`,
      replace: `const VALID_PROXY_TYPES = ["http"];`,
    },
    {
      file: "src/app/api/proxy-pools/[id]/route.js",
      find: `const validTypes = ["http", "vercel", "cloudflare", "deno", "netlify"];`,
      replace: `const validTypes = ["http"];`,
    },
    {
      file: "src/app/api/proxy-pools/[id]/test/route.js",
      find: `async function testVercelRelay`,
      cutTo: `// POST /api/proxy-pools/[id]/test`,
    },
    {
      file: "src/app/api/proxy-pools/[id]/test/route.js",
      find: `    const result = proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify"\n      ? await testVercelRelay(proxyPool.proxyUrl)\n      : await testProxyUrl({ proxyUrl: proxyPool.proxyUrl });`,
      replace: `    const result = await testProxyUrl({ proxyUrl: proxyPool.proxyUrl });`,
    },
    // ── runtimeConfig: searxng + media TTS + token-saver leftovers
    {
      file: "open-sse/config/runtimeConfig.js",
      find: `export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://localhost:8888/search");\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/config/runtimeConfig.js",
      find: `export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/config/runtimeConfig.js",
      find: `export const TOKEN_SAVER_HEADER = "x-9router-token-saver";\n`,
      replace: "",
      checkAbsent: true,
    },
    // ── thinkingLevels: kiro effort path is gone
    {
      file: "open-sse/providers/thinkingLevels.js",
      find: `import { resolveKiroEffortPath } from "../config/kiroConstants.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/providers/thinkingLevels.js",
      find: `  if (provider === "kiro" && resolveKiroEffortPath(model) === null) return null;\n`,
      replace: "",
      checkAbsent: true,
    },
    // ── registry opencode: systemone endpoint went with the media strip
    {
      file: "open-sse/providers/registry/opencode.js",
      find: `    { id: "jev-1.13-free", name: "Jev 1.13 Free", kind: "systemone" },\n  ],\n  serviceKinds: ["llm", "systemone"],\n  systemoneConfig: {\n    baseUrl: "https://opencode.ai/zen/v1/systemone",\n    headers: {\n      "x-opencode-client": "desktop",\n      "User-Agent": "opencode/1.18.31",\n    },\n  },\n  modelsFetcher:`,
      replace: `  ],\n  modelsFetcher:`,
    },
    // ── providers constants: drop the systemone kind + whitelist entry
    {
      file: "src/shared/constants/providers.js",
      find: `  "searchViaChat", "searchConfig", "fetchConfig", "credentialFallback", "systemoneConfig",`,
      replace: `  "searchViaChat", "searchConfig", "fetchConfig", "credentialFallback",`,
    },
    {
      file: "src/shared/constants/providers.js",
      find: `  { id: "systemone",   label: "System One",     icon: "psychology",        endpoint: { method: "POST", path: "/v1/systemone" }, isNew: true },\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/providers/index.js",
      find: `  "searchViaChat", "searchConfig", "fetchConfig", "systemoneConfig",`,
      replace: `  "searchViaChat", "searchConfig", "fetchConfig",`,
    },
    // ── keyAccess comment
    {
      file: "src/sse/services/keyAccess.js",
      find: ` * (embeddings, stt, systemone, video, Gemini-native TTS). A missing model`,
      replace: ` * (embeddings, stt, video, Gemini-native TTS). A missing model`,
    },
    // ── dashboard i18n layer
    {
      file: "src/app/layout.js",
      find: `import { RuntimeI18nProvider } from "@/i18n/RuntimeI18nProvider";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/app/layout.js",
      find: `        <ThemeProvider>\n          <RuntimeI18nProvider>\n            {children}\n          </RuntimeI18nProvider>\n        </ThemeProvider>`,
      replace: `        <ThemeProvider>\n          {children}\n        </ThemeProvider>`,
    },
    {
      file: "src/shared/components/Header.js",
      find: `import HeaderLanguage from "@/shared/components/HeaderLanguage";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/shared/components/Header.js",
      find: `import { translate } from "@/i18n/runtime";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/shared/components/Header.js",
      find: `        <HeaderLanguage />\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/shared/components/Header.js",
      find: `{translate(crumb.label)}`,
      replace: `{crumb.label}`,
    },
    {
      file: "src/shared/components/Header.js",
      find: `{translate(title)}`,
      replace: `{title}`,
    },
    {
      file: "src/shared/components/Header.js",
      find: `{translate(description)}`,
      replace: `{description}`,
    },
    {
      file: "src/shared/components/index.js",
      find: `export { default as LanguageSwitcher } from "./LanguageSwitcher";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/app/(dashboard)/dashboard/profile/page.js",
      find: `import LanguageSwitcher from "@/shared/components/LanguageSwitcher";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/app/(dashboard)/dashboard/profile/page.js",
      find: `import { LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";\nimport { LOCALE_FLAGS } from "@/shared/constants/locales";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/app/(dashboard)/dashboard/profile/page.js",
      find: `function getLocaleFromCookie() {\n  if (typeof document === "undefined") return "en";\n  const cookie = document.cookie\n    .split(";")\n    .find((c) => c.trim().startsWith(\`\${LOCALE_COOKIE}=\`));\n  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : "en";\n  return normalizeLocale(value);\n}\n\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/app/(dashboard)/dashboard/profile/page.js",
      find: `  const [locale, setLocale] = useState(() => getLocaleFromCookie());\n  const [langOpen, setLangOpen] = useState(false);\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/app/(dashboard)/dashboard/profile/page.js",
      find: `        {/* Language */}\n        <Card>\n          <div className="flex items-center gap-3 mb-4">\n            <div className="size-10 rounded-lg bg-blue-500/10 text-blue-500 flex items-center justify-center shrink-0">\n              <span className="material-symbols-outlined text-[20px]">language</span>\n            </div>\n            <h3 className="text-base sm:text-lg font-semibold">Language</h3>\n          </div>\n          <button\n            onClick={() => setLangOpen(true)}\n            className="flex items-center justify-between w-full p-3 rounded-lg bg-bg border border-border hover:border-primary/50 transition-colors"\n            data-i18n-skip="true"\n          >\n            <span className="text-sm text-text-muted">Display language</span>\n            <span className="text-2xl">{LOCALE_FLAGS[locale] || "🌐"}</span>\n          </button>\n        </Card>\n\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/app/(dashboard)/dashboard/profile/page.js",
      find: `      <LanguageSwitcher\n        hideTrigger\n        isOpen={langOpen}\n        onClose={(next) => {\n          setLangOpen(false);\n          setLocale(next);\n        }}\n      />\n\n`,
      replace: "",
      checkAbsent: true,
    },
    // ── cloud settings (sync is gone)
    {
      file: "src/lib/db/repos/settingsRepo.js",
      find: `export async function isCloudEnabled() {`,
      cutTo: `export async function exportSettings() {`,
    },
    {
      file: "src/lib/localDb.js",
      find: `  getSettings, updateSettings, isCloudEnabled, getCloudUrl,`,
      replace: `  getSettings, updateSettings,`,
    },
    {
      file: "src/lib/db/index.js",
      find: `  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,`,
      replace: `  getSettings, updateSettings, exportSettings,`,
    },
    {
      file: "src/models/index.js",
      find: `  isCloudEnabled,\n`,
      replace: "",
      checkAbsent: true,
    },
    // ── translator registry: drop the provider-only pairs
    {
      file: "open-sse/translator/index.js",
      find: `import "/translator/request/antigravity-to-openai.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "tests/translator/registerAll.js",
      find: `import "../../open-sse/translator/request/antigravity-to-openai.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/translator/index.js",
      find: `import "/translator/request/claude-to-kiro.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "tests/translator/registerAll.js",
      find: `import "../../open-sse/translator/request/claude-to-kiro.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/translator/index.js",
      find: `import "/translator/request/openai-to-kiro.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "tests/translator/registerAll.js",
      find: `import "../../open-sse/translator/request/openai-to-kiro.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/translator/index.js",
      find: `import "/translator/request/openai-to-commandcode.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "tests/translator/registerAll.js",
      find: `import "../../open-sse/translator/request/openai-to-commandcode.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/translator/index.js",
      find: `import "/translator/request/openai-to-cursor.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "tests/translator/registerAll.js",
      find: `import "../../open-sse/translator/request/openai-to-cursor.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/translator/index.js",
      find: `import "/translator/request/openai-to-gemini.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "tests/translator/registerAll.js",
      find: `import "../../open-sse/translator/request/openai-to-gemini.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/translator/index.js",
      find: `import "/translator/request/openai-to-ollama.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "tests/translator/registerAll.js",
      find: `import "../../open-sse/translator/request/openai-to-ollama.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/translator/index.js",
      find: `import "/translator/request/openai-to-vertex.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "tests/translator/registerAll.js",
      find: `import "../../open-sse/translator/request/openai-to-vertex.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/translator/index.js",
      find: `import "/translator/response/commandcode-to-openai.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "tests/translator/registerAll.js",
      find: `import "../../open-sse/translator/response/commandcode-to-openai.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/translator/index.js",
      find: `import "/translator/response/cursor-to-openai.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "tests/translator/registerAll.js",
      find: `import "../../open-sse/translator/response/cursor-to-openai.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/translator/index.js",
      find: `import "/translator/response/gemini-to-openai.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "tests/translator/registerAll.js",
      find: `import "../../open-sse/translator/response/gemini-to-openai.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/translator/index.js",
      find: `import "/translator/response/kiro-to-claude.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "tests/translator/registerAll.js",
      find: `import "../../open-sse/translator/response/kiro-to-claude.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/translator/index.js",
      find: `import "/translator/response/kiro-to-openai.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "tests/translator/registerAll.js",
      find: `import "../../open-sse/translator/response/kiro-to-openai.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/translator/index.js",
      find: `import "/translator/response/ollama-to-openai.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "tests/translator/registerAll.js",
      find: `import "../../open-sse/translator/response/ollama-to-openai.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "open-sse/translator/index.js",
      find: `import "/translator/response/openai-to-antigravity.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "tests/translator/registerAll.js",
      find: `import "../../open-sse/translator/response/openai-to-antigravity.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    // ── generic executor: compatible endpoints have no registry entry
    {
      file: "open-sse/executors/base.js",
      find: `  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }`,
      replace: `  constructor(provider, config) {
    this.provider = provider;
    // Custom (compatible) endpoints have no registry entry — an empty config
    // keeps the generic paths (buildUrl/buildHeaders) working.
    this.config = config || {};
    this.noAuth = this.config.noAuth || false;
  }`,
    },
    {
      file: "open-sse/executors/default.js",
      find: `    super(provider, PROVIDERS[provider] || PROVIDERS.openai);`,
      replace: `    super(provider, PROVIDERS[provider]);`,
    },
    // ── provider defaults: the pruned registry has no openai/anthropic entries
    {
      file: "open-sse/services/provider.js",
      find: `      ...PROVIDERS.openai,
      format: apiType === "responses" ? "openai-responses" : "openai",`,
      replace: `      // Compatible endpoints carry their own headers + base URL; the pruned
      // registry has no \`openai\` defaults to spread anymore.
      format: apiType === "responses" ? "openai-responses" : "openai",`,
    },
    {
      file: "open-sse/services/provider.js",
      find: `      ...PROVIDERS.anthropic, // Use Anthropic defaults (header: x-api-key)
      format: "claude",`,
      replace: `      // Anthropic-compatible headers are set by the executor (x-api-key).
      format: "claude",`,
    },
    {
      file: "open-sse/services/provider.js",
      find: `  return PROVIDERS[provider] || PROVIDERS.openai;`,
      replace: `  return PROVIDERS[provider] || {};`,
    },
    // ── suggested-models proxy: fork copy (upstream vendors pruned)
    {
      file: "src/app/api/providers/suggested-models/route.js",
      createFrom: "scripts/lean/overlays/src/app/api/providers/suggested-models/route.js",
    },
    {
      file: "src/app/api/providers/suggested-models/filters.js",
      createFrom: "scripts/lean/overlays/src/app/api/providers/suggested-models/filters.js",
    },
    // ── fork-owned rewrites (full-file overlays)
    { file: "src/app/(dashboard)/dashboard/providers/[id]/page.js", overlay: "scripts/lean/overlays/src/app/(dashboard)/dashboard/providers/[id]/page.js" },
    { file: "src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js", overlay: "scripts/lean/overlays/src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js" },
    { file: "src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js", overlay: "scripts/lean/overlays/src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js" },
    { file: "src/app/api/providers/[id]/models/route.js", overlay: "scripts/lean/overlays/src/app/api/providers/[id]/models/route.js" },
    { file: "src/app/api/providers/validate/route.js", overlay: "scripts/lean/overlays/src/app/api/providers/validate/route.js" },
    { file: "src/app/api/providers/[id]/test/testUtils.js", overlay: "scripts/lean/overlays/src/app/api/providers/[id]/test/testUtils.js" },
    { file: "src/app/api/models/test/ping.js", overlay: "scripts/lean/overlays/src/app/api/models/test/ping.js" },
    { file: "src/app/(dashboard)/dashboard/proxy-pools/page.js", overlay: "scripts/lean/overlays/src/app/(dashboard)/dashboard/proxy-pools/page.js" },
    { file: "src/app/api/v1beta/models/[...path]/route.js", overlay: "scripts/lean/overlays/src/app/api/v1beta/models/[...path]/route.js" },
    { file: "src/shared/utils/bulkAdd.js", overlay: "scripts/lean/overlays/src/shared/utils/bulkAdd.js" },
  ],
};

// ─── pool-obs ──────────────────────────────────────────────────────────────
// Pool observability + 2-pool chains on top of the sweep:
//   - Console Log restored (routes live at /api/console-log*, client patched)
//   - per-request pool attribution in log lines ("POOL:"/"pool=" with names)
//   - ordered failover chains ("__all__" = every active pool by failoverOrder)
//   - round-robin start pool rotates once per request, then walks on failure
//   - Proxy Pools: "Failover order" field (+ #n badge) and "Check setup" modal
//   - scripts/ensure-pool.mjs lets mobile-pool/setup.sh register the pool itself
// New files (console-log routes, diagnose route, ensure-pool.mjs) are plain
// additions and need no rule; this phase patches the upstream files.
PHASES["pool-obs"] = {
  title: "pool observability: console log, named pools, ordered chains, setup check",
  patch: [
    // ── connectionProxy: ordered pool plan (per-request chain)
    {
      file: "src/lib/network/connectionProxy.js",
      find: `import { getProxyPoolById } from "@/models";`,
      replace: `import { getProxyPoolById, getProxyPools } from "@/models";\nimport { getSettings } from "@/lib/localDb";`,
    },
    {
      file: "src/lib/network/connectionProxy.js",
      find: `  return remaining.reduce((best, entry) =>
    getProxyPoolCooldownUntil(best.key, model) < getProxyPoolCooldownUntil(entry.key, model) ? entry : best
  );
}`,
      replace: `  return remaining.reduce((best, entry) =>
    getProxyPoolCooldownUntil(best.key, model) < getProxyPoolCooldownUntil(entry.key, model) ? entry : best
  );
}

// ─── Per-request pool chain ────────────────────────────────────────────────
// The chat loop builds ONE plan per client request (so round-robin advances its
// start pool exactly once per request, not once per retry) and then walks the
// chain on pool-worthy failures. Entry shape: { key, poolId, label }.
//
//   failover     → [ direct, ...pools ]      pools = selected pool, or all
//                                            active pools ordered by
//                                            \`failoverOrder\` (then createdAt)
//                                            when "__all__" is selected
//   round-robin  → [...pools rotated to the next start index]
//   random       → [...pools starting at a random index]
//   none         → [ selectedPool ]          (or [] → direct)
export const ALL_POOLS_KEY = "__all__";
export const NONE_POOL_KEY = "__none__";
const DIRECT_LABEL = "direct";
const DEFAULT_FAILOVER_ORDER = 100;

function poolFailoverOrder(pool) {
  const n = Number(pool?.failoverOrder);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FAILOVER_ORDER;
}

/** Active pools with a URL, ordered for the failover chain. */
export async function getOrderedActivePools() {
  const pools = await getProxyPools({ isActive: true });
  return pools
    .filter((pool) => String(pool?.proxyUrl || "").trim())
    .sort((a, b) => (poolFailoverOrder(a) - poolFailoverOrder(b))
      || (new Date(a.createdAt || 0) - new Date(b.createdAt || 0)));
}

// Pool names for log lines. Short TTL so a rename shows up without a restart.
const poolNameCache = new Map(); // id → { name, at }
const POOL_NAME_TTL_MS = 10 * 1000;

export async function getPoolName(poolId) {
  if (!poolId) return null;
  const hit = poolNameCache.get(poolId);
  if (hit && Date.now() - hit.at < POOL_NAME_TTL_MS) return hit.name;
  try {
    const pool = await getProxyPoolById(poolId);
    const name = pool?.name || null;
    poolNameCache.set(poolId, { name, at: Date.now() });
    return name;
  } catch {
    return null;
  }
}

/**
 * Build the ordered chain of pool entries a single client request may use.
 * @returns {{ strategy: string, chain: Array<{key: string, poolId: string|null, label: string}> }}
 */
export async function buildPoolPlan(providerId, settings = null) {
  const resolvedSettings = settings || await getSettings();
  const override = (resolvedSettings?.providerStrategies || {})[providerId] || {};
  const strategy = override.rotateStrategy || "none";
  const selected = String(override.proxyPoolId || "").trim();

  const toEntry = (pool) => ({
    key: pool.id,
    poolId: pool.id,
    label: pool.name || pool.id.slice(0, 8),
  });

  let chain = [];

  if (strategy === "failover") {
    chain = [{ key: DIRECT_POOL_KEY, poolId: null, label: DIRECT_LABEL }];
    const activePools = await getOrderedActivePools();
    if (selected === ALL_POOLS_KEY) {
      chain.push(...activePools.map(toEntry));
    } else if (selected && selected !== NONE_POOL_KEY) {
      const pool = activePools.find((p) => p.id === selected);
      if (pool) chain.push(toEntry(pool));
    }
  } else if (strategy === "round-robin" || strategy === "random") {
    const activePools = await getOrderedActivePools();
    if (activePools.length > 0) {
      // pickProxyPoolId advances the in-memory rotation state; calling it once
      // per plan keeps the start pool alternating once per client request.
      const startId = pickProxyPoolId(activePools.map((p) => p.id), strategy, providerId);
      const idx = Math.max(0, activePools.findIndex((p) => p.id === startId));
      chain = [...activePools.slice(idx), ...activePools.slice(0, idx)].map(toEntry);
    }
  } else if (selected && selected !== NONE_POOL_KEY && selected !== ALL_POOLS_KEY) {
    const activePools = await getOrderedActivePools();
    const pool = activePools.find((p) => p.id === selected);
    if (pool) chain = [toEntry(pool)];
  }

  return { strategy, chain, useAllPools: selected === ALL_POOLS_KEY };
}`,
      check: `export async function buildPoolPlan(`,
    },
    // ── auth.js: plan-based chain + labels
    {
      file: "src/sse/services/auth.js",
      find: `import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools, getProxyPoolById } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId, pickChainEntry, DIRECT_POOL_KEY } from "@/lib/network/connectionProxy";`,
      replace: `import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickChainEntry, buildPoolPlan, DIRECT_POOL_KEY } from "@/lib/network/connectionProxy";`,
    },
    {
      file: "src/sse/services/auth.js",
      find: `/**
 * Failover mode (settings.providerStrategies[provider].rotateStrategy ===
 * "failover") resolves an ordered chain: direct first, then the selected pool.
 * failoverState.attempted is owned by the chat loop for one client request, so
 * a retry after a 429 lands on the next chain entry instead of the same wall.
 *
 * Returns null when failover is not configured for this provider, so callers
 * fall back to the connection/rotation behaviour.
 */
async function resolveFailoverEntry(providerId, settings, failoverState, model = "") {
  const override = (settings?.providerStrategies || {})[providerId] || {};
  if (override.rotateStrategy !== "failover") return null;

  const chain = [{ key: DIRECT_POOL_KEY, poolId: null }];
  const configuredPoolId = String(override.proxyPoolId || "").trim();
  if (configuredPoolId && configuredPoolId !== "__none__") {
    const pool = await getProxyPoolById(configuredPoolId);
    if (pool?.isActive === true && String(pool.proxyUrl || "").trim()) {
      chain.push({ key: configuredPoolId, poolId: configuredPoolId });
    }
  }

  const attempted = failoverState?.attempted instanceof Set ? failoverState.attempted : new Set();
  const entry = pickChainEntry(chain, attempted, model) || chain[0];
  return { ...entry, chainLength: chain.length };
}`,
      replace: `/**
 * Failover / rotation chains are built per client request by the chat loop
 * (buildPoolPlan) and handed in via \`options.poolPlan\`, so the round-robin
 * start pool advances exactly once per request. This function only resolves
 * the next usable entry of that plan.
 *
 * Returns null when the plan has no entries, so callers fall back to the
 * connection/rotation behaviour.
 */
function pickPlanEntry(plan, failoverState, model = "") {
  const chain = Array.isArray(plan?.chain) ? plan.chain : [];
  if (chain.length === 0) return null;
  const attempted = failoverState?.attempted instanceof Set ? failoverState.attempted : new Set();
  const entry = pickChainEntry(chain, attempted, model) || chain[0];
  return entry
    ? { ...entry, chainIndex: chain.indexOf(entry), chainLength: chain.length }
    : null;
}`,
    },
    {
      file: "src/sse/services/auth.js",
      find: `    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";

      // Failover mode: direct first, selected pool on 429 (per-request chain state).
      const failoverEntry = await resolveFailoverEntry(providerId, settings, options?.failoverState, model);
      if (failoverEntry) {
        const resolvedProxy = await resolveConnectionProxyConfig({
          proxyPoolId: failoverEntry.poolId || "",
        });
        return {
          id: "noauth",
          connectionName: "Public",
          isActive: true,
          accessToken: "public",
          providerSpecificData: {
            connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
            connectionProxyUrl: resolvedProxy.connectionProxyUrl,
            connectionNoProxy: resolvedProxy.connectionNoProxy,
            connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          },
          _poolFailover: {
            enabled: true,
            key: failoverEntry.key,
            poolId: failoverEntry.poolId || null,
            chainLength: failoverEntry.chainLength,
          },
        };
      }

      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          strictProxy: resolvedProxy.strictProxy === true,
        },
      };
    }`,
      replace: `    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const plan = options?.poolPlan || await buildPoolPlan(providerId, settings);
      const entry = pickPlanEntry(plan, options?.failoverState, model);

      const resolvedProxy = await resolveConnectionProxyConfig({
        proxyPoolId: entry?.poolId || "",
      });

      const credentials = {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          connectionProxyPoolName: entry?.poolId ? entry.label : null,
          strictProxy: resolvedProxy.strictProxy === true,
        },
      };

      // The chat loop walks a plan entry list; one entry (or none) means there
      // is nothing to walk, which keeps the pre-chain behaviour.
      if (entry) {
        credentials._poolFailover = {
          enabled: true,
          key: entry.key,
          poolId: entry.poolId || null,
          label: entry.label || null,
          index: entry.chainIndex,
          chainLength: entry.chainLength,
        };
      }

      return credentials;
    }`,
    },
    {
      file: "src/sse/services/auth.js",
      find: `    const failoverEntry = await resolveFailoverEntry(providerId, settings, options?.failoverState, model);
    const resolvedProxy = failoverEntry
      ? await resolveConnectionProxyConfig({ proxyPoolId: failoverEntry.poolId || "" })
      : await resolveConnectionProxyConfig(connection.providerSpecificData || {});`,
      replace: `    // Compat connections keep their own proxy unless the provider is in
    // failover mode; the per-request plan then provides the chain entry.
    const failoverEntry = options?.poolPlan?.strategy === "failover"
      ? pickPlanEntry(options.poolPlan, options?.failoverState, model)
      : null;
    const resolvedProxy = failoverEntry
      ? await resolveConnectionProxyConfig({ proxyPoolId: failoverEntry.poolId || "" })
      : await resolveConnectionProxyConfig(connection.providerSpecificData || {});`,
    },
    {
      file: "src/sse/services/auth.js",
      find: `        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        strictProxy: resolvedProxy.strictProxy === true,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection,
      // Failover mode bookkeeping for the chat loop (see resolveFailoverEntry)
      _poolFailover: failoverEntry
        ? {
            enabled: true,
            key: failoverEntry.key,
            poolId: failoverEntry.poolId || null,
            chainLength: failoverEntry.chainLength,
          }
        : null,`,
      replace: `        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        connectionProxyPoolName: failoverEntry?.poolId ? failoverEntry.label : null,
        strictProxy: resolvedProxy.strictProxy === true,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection,
      // Chain bookkeeping for the chat loop (see pickPlanEntry)
      _poolFailover: failoverEntry
        ? {
            enabled: true,
            key: failoverEntry.key,
            poolId: failoverEntry.poolId || null,
            label: failoverEntry.label || null,
            index: failoverEntry.chainIndex,
            chainLength: failoverEntry.chainLength,
          }
        : null,`,
    },
    // ── chat.js: one plan per request + named log lines
    {
      file: "src/sse/handlers/chat.js",
      find: `import { noteProxyPoolFailure, noteProxyPoolSuccess } from "@/lib/network/connectionProxy";`,
      replace: `import { noteProxyPoolFailure, noteProxyPoolSuccess, buildPoolPlan, getPoolName, DIRECT_POOL_KEY } from "@/lib/network/connectionProxy";`,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `  // Pool-failover state for this request: which chain entries (direct / pools)
  // were already tried. See resolveFailoverEntry in services/auth.js.
  const failoverState = { attempted: new Set(), bestError: null };
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { requestedModel: requestedModel || model, failoverState });`,
      replace: `  // Pool-chain state for this request: which entries (direct / pools) were
  // already tried. The chain itself comes from buildPoolPlan below.
  const failoverState = { attempted: new Set(), bestError: null };
  // One pool chain per client request: round-robin advances its start pool here
  // (not once per retry), and the loop below walks the chain on pool-worthy
  // failures (429 / 5xx / transport).
  const poolPlan = await buildPoolPlan(provider);
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { requestedModel: requestedModel || model, failoverState, poolPlan });`,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);`,
      check: `credPsd.connectionProxyPoolName = await getPoolName(`,
      replace: `    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Name the pool in the request "▶" line. No-auth providers already carry
    // the label from the plan; compat connections resolve it from their own
    // proxyPoolId here (single cached lookup).
    const credPsd = refreshedCredentials?.providerSpecificData;
    if (credPsd && !credPsd.connectionProxyPoolName && credPsd.connectionProxyPoolId) {
      credPsd.connectionProxyPoolName = await getPoolName(credPsd.connectionProxyPoolId);
    }`,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `    if (result.success) {
      if (credentials._poolFailover) noteProxyPoolSuccess(credentials._poolFailover.key, model);
      return result.response;
    }`,
      replace: `    if (result.success) {
      const usedPool = credentials._poolFailover || null;
      if (usedPool) noteProxyPoolSuccess(usedPool.key, model);
      if (usedPool && usedPool.key !== DIRECT_POOL_KEY && failoverState.attempted.size > 0) {
        log.info("POOL", \`✔ POOL:"\${usedPool.label || usedPool.key}" served the request after \${failoverState.attempted.size} failed attempt(s)\`);
      }
      return result.response;
    }`,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `      noteProxyPoolFailure(poolFailover.key, result.status, result.error, poolRetryAfterMs(result), model);
      if (failoverState.attempted.size < poolFailover.chainLength) {
        log.warn("FALLBACK", \`⇄ POOL:\${poolFailover.key} UNAVAILABLE (\${result.status}) → NEXT POOL\`);`,
      replace: `      noteProxyPoolFailure(poolFailover.key, result.status, result.error, poolRetryAfterMs(result), model);
      if (failoverState.attempted.size < poolFailover.chainLength) {
        const nextEntry = (poolPlan?.chain || []).find((candidate) => !failoverState.attempted.has(candidate.key));
        log.warn("FALLBACK", \`⇄ POOL:"\${poolFailover.label || poolFailover.key}" UNAVAILABLE (\${result.status}) → NEXT POOL\${nextEntry ? \` "\${nextEntry.label}"\` : ""}\`);`,
    },
    // ── chatCore: POOL label on the request line + pool name in [PROXY]
    {
      file: "open-sse/handlers/chatCore.js",
      find: `import { resolveSessionId } from "../utils/sessionManager.js";`,
      replace: `import { resolveSessionId } from "../utils/sessionManager.js";

/**
 * Pool label for the request "▶" line: a per-request chain entry carries a
 * display name plus its position (i/N); compat connections only carry the name
 * resolved by the chat handler. Returns null when no pool is involved.
 */
function poolDisplayLabel(credentials) {
  const failover = credentials?._poolFailover;
  if (failover?.enabled) {
    const name = failover.label || "pool";
    const pos = Number.isFinite(failover.index) && Number(failover.chainLength) > 1
      ? \` (\${failover.index + 1}/\${failover.chainLength})\`
      : "";
    return \`\${name}\${pos}\`;
  }
  const name = credentials?.providerSpecificData?.connectionProxyPoolName;
  if (name) return name;
  if (credentials?.providerSpecificData?.connectionProxyEnabled === true) return "pool";
  return null;
}`,
      check: `function poolDisplayLabel(credentials) {`,
    },
    {
      file: "open-sse/handlers/chatCore.js",
      find: `    const acc = credentials?.connectionName || credentials?.connectionId?.slice(0, 8) || "-";
    const parts = [
      \`POST \${clientModel} → \${provider}/\${model}\`,
      fmtStr,
      stream ? "STREAM" : "JSON",
      \`\${msgN} MSG\`,
    ];
    if (toolN) parts.push(\`\${toolN} TOOL\`);
    if (think) parts.push(\`THINK:\${think}\`);
    parts.push(\`ACC:\${acc}\`);
    log.line(reqTag, "▶", parts.join(" · "));`,
      replace: `    const acc = credentials?.connectionName || credentials?.connectionId?.slice(0, 8) || "-";
    const poolLabel = poolDisplayLabel(credentials);
    const parts = [
      \`POST \${clientModel} → \${provider}/\${model}\`,
      fmtStr,
      stream ? "STREAM" : "JSON",
      \`\${msgN} MSG\`,
    ];
    if (toolN) parts.push(\`\${toolN} TOOL\`);
    if (think) parts.push(\`THINK:\${think}\`);
    if (poolLabel) parts.push(\`POOL:\${poolLabel}\`);
    parts.push(\`ACC:\${acc}\`);
    log.line(reqTag, "▶", parts.join(" · "));`,
    },
    {
      file: "open-sse/handlers/chatCore.js",
      find: `    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.info?.("PROXY", \`\${provider.toUpperCase()} | \${model} | conn=\${connectionName} | pool=\${poolId} | url=\${maskedProxyUrl}\`);`,
      replace: `    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    const poolName = credentials?.providerSpecificData?.connectionProxyPoolName;
    const poolStr = poolName ? \`"\${poolName}" (\${String(poolId).slice(0, 8)})\` : poolId;
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.info?.("PROXY", \`\${provider.toUpperCase()} | \${model} | conn=\${connectionName} | pool=\${poolStr} | url=\${maskedProxyUrl}\`);`,
    },
    // ── NoAuthProxyCard: "all active pools" option + honest hints
    {
      file: "src/shared/components/NoAuthProxyCard.js",
      find: `const NONE_PROXY_POOL_VALUE = "__none__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "failover", label: "Failover on 429 (direct → pool)" },`,
      replace: `const NONE_PROXY_POOL_VALUE = "__none__";
const ALL_POOLS_VALUE = "__all__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "failover", label: "Failover on 429 (direct → pools)" },`,
    },
    {
      file: "src/shared/components/NoAuthProxyCard.js",
      find: `        options={[
          { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
          ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
        ]}
        hint={isRotation ? "Pool selector is ignored when rotation is active — all active pools are used." : isFailover ? "Requests go direct first; this pool takes over on HTTP 429." : undefined}`,
      replace: `        options={[
          { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
          ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
          { value: ALL_POOLS_VALUE, label: "All active pools (ordered)" },
        ]}
        hint={
          isRotation
            ? "Pool selector is ignored when rotation is active — all active pools are used."
            : isFailover
              ? proxyPoolId === ALL_POOLS_VALUE
                ? "Requests go direct first; on HTTP 429 the same request walks every active pool in Failover-order (Proxy Pools page)."
                : "Requests go direct first; this pool takes over on HTTP 429."
              : undefined
        }`,
    },
    {
      file: "src/shared/components/NoAuthProxyCard.js",
      find: `          {isFailover
            ? \`Requests use the direct connection first. On HTTP 429 the same request is retried through the selected pool, which then rests for a short cooldown.\`
            : !canRotate
              ? \`Need at least 2 active proxy pools for rotation.\`
              : isRotation
                ? rotateStrategy === "round-robin"
                  ? \`Rotating through all \${proxyPools.length} active pools in order. State is in-memory (resets on restart).\`
                  : \`Picking a random pool from \${proxyPools.length} active pools each request.\`
                : \`Uses the selected pool above. Set to Round-robin or Random to rotate across all active pools.\`}`,
      replace: `          {isFailover
            ? \`Requests use the direct connection first. On HTTP 429 the same request walks the pool chain (order = "Failover order" on the Proxy Pools page); each failed entry rests for a short cooldown.\`
            : !canRotate
              ? \`Need at least 2 active proxy pools for rotation.\`
              : isRotation
                ? rotateStrategy === "round-robin"
                  ? \`Rotating across all \${proxyPools.length} active pools: the start pool alternates on every upstream call and a rate-limited (429) pool falls through to the next, so every exit IP carries its own share of the free-tier limits. Phone data is spent in proportion; Failover keeps the phone idle until a 429.\`
                  : \`Picking a random pool from \${proxyPools.length} active pools each request; a rate-limited (429) pool falls through to the next one. Phone data is spent in proportion.\`
                : \`Uses the selected pool above. Set to Round-robin or Random to rotate across all active pools.\`}`,
    },
    // ── proxy-pools API: failoverOrder rides in the JSON data column
    {
      file: "src/app/api/proxy-pools/route.js",
      find: `  const type = VALID_PROXY_TYPES.includes(body?.type) ? body.type : "http";

  if (!name) {
    return { error: "Name is required" };
  }

  if (!proxyUrl) {
    return { error: "Proxy URL is required" };
  }

  return { name, proxyUrl, noProxy, isActive, strictProxy, type };
}`,
      replace: `  const type = VALID_PROXY_TYPES.includes(body?.type) ? body.type : "http";
  // Optional position in the failover chain (lower = tried first). Stored in the
  // pool's JSON data column, so no schema migration is needed.
  const failoverOrder = Number(body?.failoverOrder);

  if (!name) {
    return { error: "Name is required" };
  }

  if (!proxyUrl) {
    return { error: "Proxy URL is required" };
  }

  const data = { name, proxyUrl, noProxy, isActive, strictProxy, type };
  if (Number.isFinite(failoverOrder) && failoverOrder > 0) data.failoverOrder = Math.floor(failoverOrder);

  return data;
}`,
    },
    {
      file: "src/app/api/proxy-pools/[id]/route.js",
      find: `  if (Object.prototype.hasOwnProperty.call(body, "type")) {
    const validTypes = ["http"];
    updates.type = validTypes.includes(body?.type) ? body.type : "http";
  }

  return { updates };
}`,
      replace: `  if (Object.prototype.hasOwnProperty.call(body, "type")) {
    const validTypes = ["http"];
    updates.type = validTypes.includes(body?.type) ? body.type : "http";
  }

  if (Object.prototype.hasOwnProperty.call(body, "failoverOrder")) {
    const order = Number(body?.failoverOrder);
    // 0/empty clears the position (falls back to createdAt ordering).
    if (!Number.isFinite(order) || order <= 0) updates.failoverOrder = null;
    else updates.failoverOrder = Math.floor(order);
  }

  return { updates };
}`,
    },
    {
      file: "src/lib/db/repos/proxyPoolsRepo.js",
      find: `    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    testStatus: data.testStatus || "unknown",`,
      replace: `    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    // Chain position for the failover plan (lower = tried first); unset falls
    // back to createdAt ordering. Lives in the JSON data column.
    failoverOrder: Number(data.failoverOrder) > 0 ? Math.floor(Number(data.failoverOrder)) : undefined,
    testStatus: data.testStatus || "unknown",`,
    },
    // ── Console Log client: the routes live at /api/console-log* now
    {
      file: "src/app/(dashboard)/dashboard/console-log/ConsoleLogClient.js",
      find: `      await fetch("/api/translator/console-logs", { method: "DELETE" });`,
      replace: `      await fetch("/api/console-log", { method: "DELETE" });`,
    },
    {
      file: "src/app/(dashboard)/dashboard/console-log/ConsoleLogClient.js",
      find: `    const es = new EventSource("/api/translator/console-logs/stream");`,
      replace: `    const es = new EventSource("/api/console-log/stream");`,
    },
  ],
};

// ─── pool-usage ────────────────────────────────────────────────────────────
// Usage page (menu "Usage", /dashboard/pool-usage) built on top of pool-obs:
//   - one row per upstream call in usageHistory (existing table, no migration):
//     ok rows carry tokens + the serving pool; fail rows carry pool + reason
//   - donut: Pool Local / Pool Mobile / Fail (+ direct when failover mode is on)
//   - per-model table (requests, fails, fail %, tokens) + recent requests
// The upstream usage/quota stack stays deleted (usage-quota phase); new paths
// (/dashboard/pool-usage, /api/usage-stats, src/lib/usageStats.js) sit outside
// that phase's delete list so `verify all` stays green.
PHASES["pool-usage"] = {
  title: "usage page: pool/token attribution + /api/usage-stats",
  patch: [
    // Fork-owned files are plain additions (like pool-obs's console-log routes):
    //   src/lib/db/repos/usageStatsRepo.js, src/lib/usageStats.js,
    //   src/app/api/usage-stats/route.js,
    //   src/app/(dashboard)/dashboard/pool-usage/{page,PoolUsageClient}.js

    // ── requestDetail.js: ok rows (tokens + serving pool)
    {
      file: "open-sse/handlers/chatCore/requestDetail.js",
      find: `import { COLORS } from "../../utils/stream.js";\n`,
      replace: `import { COLORS } from "../../utils/stream.js";\nimport { recordUsageEvent } from "@/lib/usageStats.js";\n`,
      check: `import { recordUsageEvent } from "@/lib/usageStats.js";`,
    },
    {
      file: "open-sse/handlers/chatCore/requestDetail.js",
      find: `export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint, label = "USAGE", silent = false }) {`,
      replace: `export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint, pool = null, label = "USAGE", silent = false }) {`,
      check: `endpoint, pool = null`,
    },
    {
      file: "open-sse/handlers/chatCore/requestDetail.js",
      find: `    console.log(\`\${COLORS.green}[\${time}] 📊 [\${label}] \${provider.toUpperCase()} | in=\${inTokens} | out=\${outTokens}\${accountSuffix}\${COLORS.reset}\`);
  }

}`,
      replace: `    console.log(\`\${COLORS.green}[\${time}] 📊 [\${label}] \${provider.toUpperCase()} | in=\${inTokens} | out=\${outTokens}\${accountSuffix}\${COLORS.reset}\`);
  }

  // Fork-owned: persist one row per successful upstream call with the serving pool.
  recordUsageEvent({ ok: true, provider, model, pool, connectionId, endpoint, tokens });
}`,
      check: `recordUsageEvent({ ok: true, provider, model, pool, connectionId, endpoint, tokens`,
    },

    // ── handler call sites: forward the pool tag onto token rows
    {
      file: "open-sse/handlers/chatCore/streamingHandler.js",
      find: `    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE", silent: true });`,
      replace: `    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, pool: clientRawRequest?._poolName || null, label: "STREAM USAGE", silent: true });`,
      check: `pool: clientRawRequest?._poolName || null,`
    },
    {
      file: "open-sse/handlers/chatCore/nonStreamingHandler.js",
      find: `  saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, silent: true });`,
      replace: `  saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, pool: clientRawRequest?._poolName || null, silent: true });`,
      check: `pool: clientRawRequest?._poolName || null,`
    },
    {
      // Two identical call sites (6-space and 4-space indent) → one rule.
      file: "open-sse/handlers/chatCore/sseToJsonHandler.js",
      find: `saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, silent: true });`,
      replace: `saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, pool: clientRawRequest?._poolName || null, silent: true });`,
      allowMultiple: true,
      check: `pool: clientRawRequest?._poolName || null,`
    },

    // ── chat.js: pool tag per attempt + one fail row per failed attempt
    {
      file: "src/sse/handlers/chat.js",
      find: `import { noteProxyPoolFailure, noteProxyPoolSuccess, buildPoolPlan, getPoolName, DIRECT_POOL_KEY } from "@/lib/network/connectionProxy";`,
      replace: `import { noteProxyPoolFailure, noteProxyPoolSuccess, buildPoolPlan, getPoolName, DIRECT_POOL_KEY } from "@/lib/network/connectionProxy";\nimport { recordUsageEvent } from "@/lib/usageStats.js";`,
      check: `import { recordUsageEvent } from "@/lib/usageStats.js";`,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `    // Use shared chatCore
    const chatSettings = await getSettings();`,
      replace: `    // Tag this attempt with the pool that will carry it, so the token rows
    // written in the chatCore handlers can be attributed (Usage page).
    if (clientRawRequest) {
      clientRawRequest._poolName = refreshedCredentials?._poolFailover?.label
        || credPsd?.connectionProxyPoolName
        || null;
    }

    // Use shared chatCore
    const chatSettings = await getSettings();`,
      check: `clientRawRequest._poolName = refreshedCredentials?._poolFailover?.label`,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `    if (result.success) {
      const usedPool = credentials._poolFailover || null;`,
      replace: `    if (!result.success) {
      // One row per failed attempt (pool + reason) so the Usage page can count
      // fails per model and per exit IP.
      recordUsageEvent({
        ok: false,
        provider,
        model,
        pool: credentials._poolFailover?.label || credPsd?.connectionProxyPoolName || null,
        poolKey: credentials._poolFailover?.key || null,
        reason: result.status ? String(result.status) : "transport",
        endpoint: clientRawRequest?.endpoint || null,
      });
    }

    if (result.success) {
      const usedPool = credentials._poolFailover || null;`,
      check: `reason: result.status ? String(result.status) : "transport",`,
    },


    // ── dashboard nav + header
    {
      file: "src/shared/components/Sidebar.js",
      find: `const navItems = [
  { href: "/dashboard/endpoint", label: "Endpoint & Key", icon: "api" },`,
      replace: `const navItems = [
  { href: "/dashboard/pool-usage", label: "Usage", icon: "bar_chart" },
  { href: "/dashboard/endpoint", label: "Endpoint & Key", icon: "api" },`,
      check: `{ href: "/dashboard/pool-usage", label: "Usage", icon: "bar_chart" },`,
    },
    {
      file: "src/shared/components/Header.js",
      find: `  if (pathname.includes("/console-log"))`,
      replace: `  if (pathname.includes("/pool-usage"))
    return {
      title: "Usage",
      description: "Requests, proxy pools and token usage",
      icon: "bar_chart",
      breadcrumbs: [],
    };
  if (pathname.includes("/console-log"))`,
      check: `title: "Usage",`,
    },
  ],
};

// ─── zen-caps ──────────────────────────────────────────────────────────────
// Pin the OpenCode Free (Zen) free-tier limits at their models.dev values and
// make /v1/models actually publish them:
//   - the generic patterns mis-size the Zen ids: `*step-*` says 128k while
//     step-5-preview-free is 1M, and the "-free" DeepSeek/MiMo variants are
//     capped at 200k although their family patterns say 1M
//   - in this fork the DB holds no provider connections (OpenCode Free is a
//     virtual no-auth connection), so /v1/models took the "DB unavailable"
//     static branch and never emitted context_length/max_completion_tokens
PHASES["zen-caps"] = {
  title: "OpenCode Free: pinned limits + live model list + /v1/models publishing",
  patch: [
    {
      file: "open-sse/providers/capabilities.js",
      find: `  "big-pickle":        { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 32000 },\n`,
      replace: `  "big-pickle":        { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 32000 },

  // Zen free-tier limits pinned at their models.dev values (checked 2026-10-16).
  // The generic patterns mis-size these: \`*step-*\` says 128k (step-5 is 1M)
  // and the "-free" DeepSeek/MiMo ids are capped at 200k while their family
  // patterns say 1M. Flags are kept exactly as the patterns resolved them.
  "step-5-preview-free":          { reasoning: true, thinkingFormat: "step", contextWindow: 1000000, maxOutput: 65536 },
  "nemotron-3.5-super-vl-free":   { vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 },
  "nemotron-3.5-lightning-free":  { reasoning: true, contextWindow: 262144, maxOutput: 262144 },
  "cat-jam-free":                 { contextWindow: 1048576, maxOutput: 131072 },
  "mimo-v2.6-flash-free":         { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 32000 },
  "deepseek-v4.1-flash-free":     { vision: true, reasoning: true, thinkingFormat: "deepseek", thinkingEffortSupported: true, contextWindow: 200000, maxOutput: 32000 },
`,
      check: `"step-5-preview-free":          { reasoning: true`,
    },
    {
      // models.dev corrected cat-jam-free to 1M after the first pin (caught live
      // by the extended sync); keep the table in step so fresh installs agree.
      file: "open-sse/providers/capabilities.js",
      find: `  "cat-jam-free":                 { contextWindow: 262144, maxOutput: 131072 },`,
      replace: `  "cat-jam-free":                 { contextWindow: 1048576, maxOutput: 131072 },`,
      check: `"cat-jam-free":                 { contextWindow: 1048576`,
    },
    {
      file: "src/app/api/v1/models/route.js",
      find: `  if (connections.length === 0) {
    // DB unavailable -> return static models, filtered by per-model kind`,
      replace: `  // No usable connection at all -> static list. In this fork the DB holds no
  // provider rows — OpenCode Free is a virtual no-auth connection — so the
  // synthetic entries above are the normal case; counting them lets the
  // per-provider loop below publish capabilities plus context_length /
  // max_completion_tokens from the capability tables.
  if (activeConnectionByProvider.size === 0) {
    // DB unavailable -> return static models, filtered by per-model kind`,
      check: `if (activeConnectionByProvider.size === 0) {`,
    },
    {
      file: "src/app/api/v1/models/route.js",
      find: `import { capabilitiesFromServiceKind, getCapabilitiesForModel, aggregateComboCapabilities } from "open-sse/providers/capabilities.js";\n`,
      replace: `import { capabilitiesFromServiceKind, getCapabilitiesForModel, aggregateComboCapabilities } from "open-sse/providers/capabilities.js";\nimport { getModelReality } from "@/lib/modelCatalog/liveModels.js";\n`,
      check: `import { getModelReality } from "@/lib/modelCatalog/liveModels.js";`,
    },
    {
      file: "src/app/api/v1/models/route.js",
      find: `      const mergedModelIds = Array.from(new Set([...modelIds, ...customModelIds, ...aliasModelIds]));

      for (const modelId of mergedModelIds) {`,
      replace: `      const mergedModelIds = Array.from(new Set([...modelIds, ...customModelIds, ...aliasModelIds]));

      // zen-caps: the upstream owns this catalogue (modelsFetcher). Hide ids it
      // no longer lists (union-alpha was retired) and surface new live free ids
      // without dashboard clicks (jev-1.13-free), while the models.dev copy keeps
      // ids that are only temporarily missing from the live list (step-5).
      const reality = await getModelReality(providerId);
      const listedModelIds = reality
        ? [
            ...mergedModelIds.filter((id) => reality.alive.has(id)),
            ...reality.live.filter((id) => !mergedModelIds.includes(id)),
          ]
        : mergedModelIds;

      for (const modelId of listedModelIds) {`,
      check: `const reality = await getModelReality(providerId);`,
    },
    {
      file: "src/app/api/models/route.js",
      find: `import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";\n`,
      replace: `import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";\nimport { getModelReality } from "@/lib/modelCatalog/liveModels.js";\n`,
      check: `import { getModelReality } from "@/lib/modelCatalog/liveModels.js";`,
    },
    {
      file: "src/app/api/models/route.js",
      find: `    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);`,
      replace: `    // zen-caps: upstream-owned catalogue — hide retired ids (union-alpha) and
    // surface new live free ids so the dashboard picker stays current.
    const reality = await getModelReality("opencode");
    if (reality) {
      const present = new Set(models.map((m) => m.model));
      const kept = models.filter((m) => (m.provider !== "oc" && m.provider !== "opencode") || reality.alive.has(m.model));
      for (const id of reality.live) {
        if (present.has(id)) continue;
        const c = getCapabilitiesForModel("opencode", id);
        kept.push({
          provider: "oc",
          model: id,
          name: id,
          fullModel: \`oc/\${id}\`,
          routedModel: \`oc/\${id}\`,
          alias: modelAliases[\`oc/\${id}\`] || id,
          caps: { vision: c.vision, search: c.search, reasoning: c.reasoning, contextWindow: c.contextWindow, maxOutput: c.maxOutput },
        });
      }
      return NextResponse.json({ models: kept });
    }

    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);`,
      check: `const reality = await getModelReality("opencode");`,
    },
    {
      file: "src/lib/modelCatalog/sync.js",
      find: `  const entries = [];
  for (const provider of registry) {
    for (const model of provider.models || []) {
      entries.push({
        provider: provider.id,
        model: model.id,
        contextLength: model.contextLength,
        current: getCapabilitiesForModel(provider.id, model.id),
      });
    }
  }
  return entries;
}`,
      replace: `  const entries = [];
  const seen = new Set();
  const addEntry = (provider, model, contextLength) => {
    const key = \`\${provider}|\${model}\`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      provider,
      model,
      contextLength,
      current: getCapabilitiesForModel(provider, model),
    });
  };
  for (const provider of registry) {
    for (const model of provider.models || []) {
      addEntry(provider.id, model.id, model.contextLength);
    }
  }
  // zen-caps: providers that own their catalogue upstream (modelsFetcher) only
  // name a few models in the registry. Include the live list and the models.dev
  // copy so every servable id gets its delta evaluated — otherwise those limits
  // never refresh and stay hand-pinned forever.
  const { getLiveModelIds, getCatalogRawModelIds } = await import("./liveModels.js");
  for (const provider of registry) {
    if (!provider.modelsFetcher) continue;
    const live = (await getLiveModelIds(provider.id, { ttlMs: 0 })) || [];
    const ids = new Set([...live, ...getCatalogRawModelIds(provider.id, { freeOnly: true })]);
    for (const id of ids) addEntry(provider.id, id, undefined);
  }
  return entries;
}`,
      check: `const addEntry = (provider, model, contextLength) =>`,
    },
  ],
};

PHASES["no-combo"] = {
  title: "remove Combo & Vision Adapter (per-model routing only)",
  delete: [
    "open-sse/services/combo.js",
    "open-sse/services/capacityAdapter.js",
    "src/app/api/combos",
    "src/app/(dashboard)/dashboard/combos",
    "src/shared/components/ComboFormModal.js",
    "src/lib/db/repos/combosRepo.js",
    "src/lib/comboPresets.js",
    "tests/unit/combo-capabilities.test.js",
    "tests/unit/combo-routing.test.js",
    "tests/unit/combo-fusion.test.js",
    "tests/unit/fusion-strip-stream-options-3024.test.js",
    "tests/unit/hermes-vision-detection.test.js",
  ],
  patch: [
    // ── chat handler: single-model path only (no combo branch, no adapter remap)
    {
      file: "src/sse/handlers/chat.js",
      find: `import { getModelInfo, getComboModels } from "../services/model.js";`,
      replace: `import { getModelInfo } from "../services/model.js";`,
      check: `import { getModelInfo } from "../services/model.js";`,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `import { getKeyAccessContext, enforceKeyAccess, filterAdapterModels } from "../services/keyAccess.js";`,
      replace: `import { getKeyAccessContext, enforceKeyAccess } from "../services/keyAccess.js";`,
      check: `import { getKeyAccessContext, enforceKeyAccess } from "../services/keyAccess.js";`,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots`,
      replace: `  // Bypass naming/warmup requests before any credential or rotation work`,
      check: `  // Bypass naming/warmup requests before any credential or rotation work`,
    },
    // Nested combo branch in handleSingleModelChat first: the top-level branch is
    // cut after it, so the 2-space anchor cannot match inside the removed block.
    {
      file: "src/sse/handlers/chat.js",
      find: `  // If provider is null, this might be a combo name - check and handle`,
      replace: `  // A null provider means the string matched no provider, alias or node.`,
      check: `  // A null provider means the string matched no provider, alias or node.`,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `    const comboModels = await getComboModels(modelStr);
    if (comboModels) {`,
      cutTo: `    log.warn("CHAT", "Invalid model format", { model: modelStr });`,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `  const requiredCapabilities = detectRequiredCapabilities(body);`,
      cutTo: `  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, contextMarker`,
    },

    // ── model resolution: combos are gone, every request is a single model
    {
      file: "src/sse/services/model.js",
      find: `import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";`,
      replace: `import { getModelAliases, getProviderNodes } from "@/lib/localDb";`,
      check: `import { getModelAliases, getProviderNodes } from "@/lib/localDb";`,
    },
    {
      file: "src/sse/services/model.js",
      find: `  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  return getModelInfoCore(modelStr, getModelAliases);
`,
      replace: `  return getModelInfoCore(modelStr, getModelAliases);
`,
      checkAbsent: true,
    },
    {
      file: "src/sse/services/model.js",
      cutFrom: `/**
 * Check if model is a combo and get models list`,
    },

    // ── key access: allow lists hold models only
    {
      file: "src/sse/services/keyAccess.js",
      find: `// Per-API-key access control for the /v1/* inference keys.
//
// Two modes per key: UNRESTRICTED (default — exactly today's behaviour) or
// RESTRICTED, where the key may call ONLY the combos and models in its allow
// list. No wildcards, no deny mode. Matching is exact and case-insensitive, on
// RESOLVED identities, so every spelling that routes to the same target is
// treated the same and no spelling can route somewhere the list does not name:
//
//   * a request that routes as a combo (getComboModels — the lookup routing
//     itself uses) is allowed iff that combo's name is listed;
//   * a request that routes to a model is allowed iff its resolved
//     \`providerId/model\` equals the resolved \`providerId/model\` of a listed
//     model entry. So \`cx/gpt-5\`, \`codex/gpt-5\` and an alias that points there
//     are one target; a raw string that merely looks like a listed entry but
//     routes elsewhere (e.g. \`MAIN\` when the combo is \`Main\`, which routes to
//     \`openai/MAIN\`) is not;
//   * search/fetch (provider IS the model) are allowed iff the resolved
//     provider id is listed, or the request is a listed combo.
//
// An allowed combo grants its members when they are reached THROUGH that combo
// (the check runs once, on the requested target, before combo expansion). It
// does not grant calling a member directly by name — that needs its own entry.
// The check runs before any credential lookup, so a denied request never
// touches a provider account.`,
      replace: `// Per-API-key access control for the /v1/* inference keys.
//
// Two modes per key: UNRESTRICTED (default — exactly today's behaviour) or
// RESTRICTED, where the key may call ONLY the models in its allow list. No
// wildcards, no deny mode. Matching is exact and case-insensitive, on RESOLVED
// identities, so every spelling that routes to the same target is treated the
// same and no spelling can route somewhere the list does not name:
//
//   * a request that routes to a model is allowed iff its resolved
//     \`providerId/model\` equals the resolved \`providerId/model\` of a listed
//     model entry. So \`cx/gpt-5\`, \`codex/gpt-5\` and an alias that points there
//     are one target; a raw string that merely looks like a listed entry but
//     routes elsewhere (e.g. \`MAIN\` as an alias of \`openai/MAIN\`) is not;
//   * search/fetch (provider IS the model) are allowed iff the resolved
//     provider id is listed.
//
// The check runs before any credential lookup, so a denied request never
// touches a provider account.`,
      check: `// RESTRICTED, where the key may call ONLY the models in its allow list. No`,
    },
    {
      file: "src/sse/services/keyAccess.js",
      find: `import { getCombos } from "@/lib/db/repos/combosRepo.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/sse/services/keyAccess.js",
      find: `import { getModelInfo, getComboModels } from "./model.js";`,
      replace: `import { getModelInfo } from "./model.js";`,
      check: `import { getModelInfo } from "./model.js";`,
    },
    {
      file: "src/sse/services/keyAccess.js",
      find: `import {
  KEY_ACCESS_COMBO_OWNER,
  KEY_ACCESS_PROVIDER_AS_MODEL_KINDS,
  keyAccessDeniedMessage,
} from "@/shared/constants/keyAccess.js";`,
      replace: `import {
  KEY_ACCESS_PROVIDER_AS_MODEL_KINDS,
  keyAccessDeniedMessage,
} from "@/shared/constants/keyAccess.js";`,
      checkAbsent: true,
    },
    {
      file: "src/sse/services/keyAccess.js",
      find: `  const comboNames = new Set((await getCombos()).map((c) => lower(c.name)));
  const combos = new Set();
  const models = new Set();
  const providers = new Set();
  for (const entry of ctx.allow) {
    const key = lower(entry);
    if (comboNames.has(key)) {
      combos.add(key);
      continue;
    }
    const info = await getModelInfo(entry);`,
      replace: `  const models = new Set();
  const providers = new Set();
  for (const entry of ctx.allow) {
    const key = lower(entry);
    const info = await getModelInfo(entry);`,
      checkAbsent: true,
    },
    {
      file: "src/sse/services/keyAccess.js",
      find: `  ctx._sets = { combos, models, providers };`,
      replace: `  ctx._sets = { models, providers };`,
      check: `  ctx._sets = { models, providers };`,
    },
    {
      file: "src/sse/services/keyAccess.js",
      find: `  const info = await getModelInfo(requested);
  // provider null ⇔ an existing combo with no members (routes nowhere).
  if (!info?.provider) return sets.combos.has(lower(requested));
  return sets.models.has(canonicalModel(info.provider, info.model));`,
      replace: `  const info = await getModelInfo(requested);
  if (!info?.provider) return false;
  return sets.models.has(canonicalModel(info.provider, info.model));`,
      checkAbsent: true,
    },
    {
      file: "src/sse/services/keyAccess.js",
      find: `  const sets = await getAllowSets(ctx);
  const comboModels = await getComboModels(requested);
  const allowed = comboModels
    ? sets.combos.has(lower(requested))
    : await isModelStringAllowed(ctx, requested);
  return allowed ? null : keyAccessDeniedResponse(ctx, requested);`,
      replace: `  const allowed = await isModelStringAllowed(ctx, requested);
  return allowed ? null : keyAccessDeniedResponse(ctx, requested);`,
      checkAbsent: true,
    },
    {
      file: "src/sse/services/keyAccess.js",
      find: `export async function enforceKeyAccessProvider(ctx, requested, comboModels) {
  if (!ctx) return null;
  if (typeof requested !== "string" || !requested) return keyAccessDeniedResponse(ctx, String(requested ?? ""));
  const sets = await getAllowSets(ctx);
  const allowed = comboModels
    ? sets.combos.has(lower(requested))
    : sets.providers.has(lower(resolveProviderId(requested)));
  return allowed ? null : keyAccessDeniedResponse(ctx, requested);
}`,
      replace: `export async function enforceKeyAccessProvider(ctx, requested) {
  if (!ctx) return null;
  if (typeof requested !== "string" || !requested) return keyAccessDeniedResponse(ctx, String(requested ?? ""));
  const sets = await getAllowSets(ctx);
  return sets.providers.has(lower(resolveProviderId(requested))) ? null : keyAccessDeniedResponse(ctx, requested);
}`,
      checkAbsent: true,
    },
    {
      file: "src/sse/services/keyAccess.js",
      find: ` * Gate for search/fetch, where the provider IS the model.
 * @param {string[]|null} comboModels - routing's own combo resolution for \`requested\`
 */`,
      replace: ` * Gate for search/fetch, where the provider IS the model.
 */`,
      checkAbsent: true,
    },
    {
      file: "src/sse/services/keyAccess.js",
      find: `// Resolve the allow list once per request: combo names, resolved model ids,
// and resolved provider ids (for provider-as-model kinds).`,
      replace: `// Resolve the allow list once per request: resolved model ids and resolved
// provider ids (for provider-as-model kinds).`,
      check: `// Resolve the allow list once per request: resolved model ids and resolved`,
    },
    {
      file: "src/sse/services/keyAccess.js",
      find: `/**
 * Capacity-adapter models are appended by the gateway, not chosen by the`,
      cutTo: `/** /v1/models: a restricted key sees only the combos and models it may call. */`,
    },
    {
      file: "src/sse/services/keyAccess.js",
      find: `/** /v1/models: a restricted key sees only the combos and models it may call. */`,
      replace: `/** /v1/models: a restricted key sees only the models it may call. */`,
      check: `/** /v1/models: a restricted key sees only the models it may call. */`,
    },
    {
      file: "src/sse/services/keyAccess.js",
      find: `    if (entry.owned_by === KEY_ACCESS_COMBO_OWNER) {
      if (sets.combos.has(lower(entry.id))) out.push(entry);
      continue;
    }\n`,
      replace: "",
      checkAbsent: true,
    },

    // ── /v1/models: combos are no longer listed
    {
      file: "src/app/api/v1/models/route.js",
      find: `import { getProviderConnections, getCombos, getCustomModels, getModelAliases } from "@/lib/localDb";`,
      replace: `import { getProviderConnections, getCustomModels, getModelAliases } from "@/lib/localDb";`,
      check: `import { getProviderConnections, getCustomModels, getModelAliases } from "@/lib/localDb";`,
    },
    {
      file: "src/app/api/v1/models/route.js",
      find: `import { capabilitiesFromServiceKind, getCapabilitiesForModel, aggregateComboCapabilities } from "open-sse/providers/capabilities.js";`,
      replace: `import { capabilitiesFromServiceKind, getCapabilitiesForModel } from "open-sse/providers/capabilities.js";`,
      check: `import { capabilitiesFromServiceKind, getCapabilitiesForModel } from "open-sse/providers/capabilities.js";`,
    },
    {
      file: "src/app/api/v1/models/route.js",
      find: `// Combo seats use UI aliases; the model registry also has transport aliases.
// Capability overrides and catalog limits are keyed by provider id.
const ALIAS_TO_PROVIDER_ID = {
  ...Object.fromEntries(
    Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])
  ),
  ...ALIAS_TO_ID,
};

function comboSeatCapabilities(seat) {
  const slash = seat.indexOf("/");
  if (slash <= 0) return null;
  const alias = seat.slice(0, slash);
  return getCapabilitiesForModel(ALIAS_TO_PROVIDER_ID[alias] || alias, seat.slice(slash + 1));
}
`,
      replace: `// UI aliases vs the model registry's transport aliases; capability overrides
// and catalog limits are keyed by provider id.
const ALIAS_TO_PROVIDER_ID = {
  ...Object.fromEntries(
    Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])
  ),
  ...ALIAS_TO_ID,
};
`,
      check: `// UI aliases vs the model registry's transport aliases; capability overrides`,
    },
    {
      file: "src/app/api/v1/models/route.js",
      find: `// LLM kind sentinel — combos/models with no explicit kind default to LLM`,
      replace: `// LLM kind sentinel — models with no explicit kind default to LLM`,
      check: `// LLM kind sentinel — models with no explicit kind default to LLM`,
    },
    {
      file: "src/app/api/v1/models/route.js",
      find: `// Combo matches kindFilter when its \`kind\` field is in the list.
// Combos with no kind are treated as LLM.
function comboMatchesKinds(combo, kindFilter) {
  const kind = combo?.kind || LLM_KIND;
  return kindFilter.includes(kind);
}

`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/app/api/v1/models/route.js",
      find: `// Nested combo names are valid seats — the model selector exposes them and`,
      cutTo: `/**
 * Build OpenAI-format models list filtered by service kinds.`,
    },
    {
      file: "src/app/api/v1/models/route.js",
      find: `  let combos = [];
  try {
    combos = await getCombos();
  } catch (e) {
    console.log("Could not fetch combos");
  }

`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/app/api/v1/models/route.js",
      find: `  const combosByName = new Map(
    combos.filter((c) => typeof c?.name === "string").map((c) => [c.name, c]),
  );

  // Lookup map so aggregateComboCapabilities can recursively resolve nested combos
  const comboByName = Object.fromEntries(combos.map((c) => [c.name, c.models]));

  // Combos first (filtered by kind). Web combos expose \`kind\` so AI knows search vs fetch.
  for (const combo of combos) {
    if (!comboMatchesKinds(combo, kindFilter)) continue;
    const entry = {
      id: combo.name,
      object: "model",
      owned_by: "combo",
    };
    if (combo.kind === "webSearch" || combo.kind === "webFetch") {
      entry.kind = combo.kind;
    } else {
      const comboCaps = aggregateComboCapabilities(combo.models, comboByName, comboSeatCapabilities);
      if (comboCaps) entry.capabilities = comboCaps;
      // Any seat can serve the request, so the only window a combo can promise is
      // its smallest. Combo entries were the only models on this endpoint that
      // published no limits at all, which leaves a client to guess from the name —
      // and it guesses high (see the snake_case note on the per-provider path).
      const { contextWindow, maxOutput } = comboSeatLimits(combo, combosByName);
      if (Number.isFinite(contextWindow)) entry.context_length = contextWindow;
      if (Number.isFinite(maxOutput)) entry.max_completion_tokens = maxOutput;
    }
    models.push(entry);
  }

`,
      replace: "",
      checkAbsent: true,
    },

    // ── capability aggregation helper (combos only)
    {
      file: "open-sse/providers/capabilities.js",
      find: `/**
 * Aggregate capabilities for a combo from its constituent model IDs.`,
      cutTo: `/**
 * Resolve capabilities for a model using the 4-step fallback chain,`,
    },

    // ── settings: combo strategy + adapter knobs are gone
    {
      file: "src/app/api/settings/route.js",
      find: `import { resetComboRotation } from "open-sse/services/combo.js";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/app/api/settings/route.js",
      find: `    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/lib/db/repos/settingsRepo.js",
      find: `  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/lib/db/repos/settingsRepo.js",
      find: `  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
  },
`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/lib/db/repos/settingsRepo.js",
      find: `  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/lib/db/repos/settingsRepo.js",
      find: `  if (merged.capacityAdapter && typeof merged.capacityAdapter === "object") {
    for (const capKey of Object.keys(merged.capacityAdapter)) {
      const entry = merged.capacityAdapter[capKey];
      if (Array.isArray(entry?.models)) {
        entry.models = entry.models.map((m) =>
          m === "oc/mimo-v2.5-free" ? "oc/mimo-v2.6-flash-free" : m
        );
      }
    }
  }
  return merged;
`,
      replace: `  return merged;
`,
      checkAbsent: true,
    },

    // ── DB layer: no combos column/table wiring
    {
      file: "src/lib/db/index.js",
      find: `// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/lib/db/index.js",
      find: `    combos: db.all(\`SELECT * FROM combos\`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })),\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/lib/db/index.js",
      find: `    db.run(\`DELETE FROM combos\`);\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/lib/db/index.js",
      find: `    for (const c of payload.combos || []) {
      db.run(
        \`INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)\`,
        [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/lib/localDb.js",
      find: `  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/models/index.js",
      find: `  getCombos,
  getComboById,
  getComboByName,
  createCombo,
  updateCombo,
  deleteCombo,
`,
      replace: "",
      checkAbsent: true,
    },

    // ── schema: drop the table, versioned migration 002 does the DDL for old DBs
    {
      file: "src/lib/db/schema.js",
      find: `export const SCHEMA_VERSION = 2;`,
      replace: `export const SCHEMA_VERSION = 3;`,
      check: `export const SCHEMA_VERSION = 3;`,
    },
    {
      file: "src/lib/db/schema.js",
      find: `  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/lib/db/migrations/index.js",
      find: `import m001 from "./001-initial.js";

export const MIGRATIONS = [m001].sort((a, b) => a.version - b.version);`,
      replace: `import m001 from "./001-initial.js";
import m002 from "./002-drop-combos.js";

export const MIGRATIONS = [m001, m002].sort((a, b) => a.version - b.version);`,
      check: `import m002 from "./002-drop-combos.js";`,
    },
    {
      file: "src/lib/db/migrate.js",
      find: `  importWithAssertion(adapter, "combos", data.combos || [], (c) => {
    adapter.run(
      \`INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)\`,
      [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
    );
  }, (c) => ({ id: c.id ?? null, name: c.name ?? null }));

`,
      replace: "",
      checkAbsent: true,
    },

    // ── UI: nav, header, guard, profile knobs, pickers, endpoint copy
    {
      file: "src/shared/constants/keyAccess.js",
      find: `// /v1/models owner tag for combo entries.
export const KEY_ACCESS_COMBO_OWNER = "combo";

`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/shared/components/Sidebar.js",
      find: `  { href: "/dashboard/combos", label: "Combo & Vision Adapter", icon: "layers" },\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/shared/components/Header.js",
      find: `  if (pathname.includes("/combos"))
    return {
      title: "Combos",
      description: "Model combos with fallback",
      icon: "layers",
      breadcrumbs: [],
    };
`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/shared/components/index.js",
      find: `export { default as ComboFormModal } from "./ComboFormModal";\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/dashboardGuard.js",
      find: `  "/api/combos",\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/app/(dashboard)/dashboard/profile/page.js",
      find: `  const updateComboStrategy = async (strategy) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStrategy: strategy }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, comboStrategy: strategy }));
      }
    } catch (err) {
      console.error("Failed to update combo strategy:", err);
    }
  };

`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/app/(dashboard)/dashboard/profile/page.js",
      find: `  const updateComboStickyLimit = async (limit) => {
    const numLimit = parseInt(limit);
    if (isNaN(numLimit) || numLimit < 1) return;

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStickyRoundRobinLimit: numLimit }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, comboStickyRoundRobinLimit: numLimit }));
      }
    } catch (err) {
      console.error("Failed to update combo sticky limit:", err);
    }
  };

`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/app/(dashboard)/dashboard/profile/page.js",
      find: `            {/* Combo Round Robin */}
            <div className="flex items-start sm:items-center justify-between gap-4 pt-4 border-t border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Combo Round Robin</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  Cycle through providers in combos instead of always starting with first
                </p>
              </div>
              <Toggle
                checked={settings.comboStrategy === "round-robin"}
                onChange={() => updateComboStrategy(settings.comboStrategy === "round-robin" ? "fallback" : "round-robin")}
                disabled={loading}
              />
            </div>

`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/app/(dashboard)/dashboard/profile/page.js",
      find: `            {/* Combo Sticky Round Robin Limit */}
            {settings.comboStrategy === "round-robin" && (
              <div className="flex items-center justify-between pt-2 border-t border-border/50">
                <div>
                  <p className="font-medium">Combo Sticky Limit</p>
                  <p className="text-sm text-text-muted">
                    Calls per combo model before switching
                  </p>
                </div>
                <Input
                  type="number"
                  min="1"
                  max="100"
                  value={settings.comboStickyRoundRobinLimit || 1}
                  onChange={(e) => updateComboStickyLimit(e.target.value)}
                  disabled={loading}
                  className="w-20 text-center"
                />
              </div>
            )}

`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/app/(dashboard)/dashboard/profile/page.js",
      find: `              {settings.comboStrategy === "round-robin"
                ? \` Combos rotate after \${settings.comboStickyRoundRobinLimit || 1} call\${(settings.comboStickyRoundRobinLimit || 1) === 1 ? "" : "s"} per model.\`
                : " Combos always start with their first model."}
`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/shared/components/ModelSelectModal.js",
      find: `// but the frontend omitted it, hiding Zed entirely from the Combo picker.`,
      replace: `// but the frontend omitted it, hiding Zed entirely from the model picker.`,
      check: `// but the frontend omitted it, hiding Zed entirely from the model picker.`,
    },
    {
      file: "src/shared/components/ModelSelectModal.js",
      find: `  const [combos, setCombos] = useState([]);\n`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/shared/components/ModelSelectModal.js",
      find: `  const fetchCombos = async () => {
    try {
      const res = await fetch("/api/combos");
      if (!res.ok) throw new Error(\`Failed to fetch combos: \${res.status}\`);
      const data = await res.json();
      setCombos(data.combos || []);
    } catch (error) {
      console.error("Error fetching combos:", error);
      setCombos([]);
    }
  };

  useEffect(() => {
    if (isOpen) fetchCombos();
  }, [isOpen]);

`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/shared/components/ModelSelectModal.js",
      find: `  // Filter combos by search query (and hide combos when kindFilter is set — combos are LLM-only by design)
  const filteredCombos = useMemo(() => {
    if (kindFilter || capFilter) return [];
    if (parsedQuery.isEmpty) return combos;
    return combos.filter(c => matchesSearch(c.name, parsedQuery));
  }, [combos, parsedQuery, kindFilter, capFilter]);

`,
      replace: "",
      checkAbsent: true,
    },
    {
      file: "src/shared/components/ModelSelectModal.js",
      find: `        {/* Combos section - always first */}`,
      cutTo: `        {/* Provider models */}`,
    },
    {
      file: "src/shared/components/ModelSelectModal.js",
      find: `      {Object.keys(filteredGroups).length === 0 && filteredCombos.length === 0 && (`,
      replace: `      {Object.keys(filteredGroups).length === 0 && (`,
      check: `      {Object.keys(filteredGroups).length === 0 && (`,
    },
    {
      file: "src/shared/utils/modelSearchFilter.js",
      find: ` * Filter an array of model or combo objects by a search query.`,
      replace: ` * Filter an array of model objects by a search query.`,
      check: ` * Filter an array of model objects by a search query.`,
    },
    {
      file: "src/app/(dashboard)/dashboard/endpoint/components/KeyAccessControls.js",
      find: `// Per-API-key access control on the Endpoint page.
// "Restrict access" toggle per key; when on, the key may call only the listed
// combos/models, shown as removable badges. Entries are picked with the same
// shared ModelSelectModal the combo editor uses (combos first, then models).`,
      replace: `// Per-API-key access control on the Endpoint page.
// "Restrict access" toggle per key; when on, the key may call only the listed
// models, shown as removable badges (picked with the shared ModelSelectModal).`,
      check: `// models, shown as removable badges (picked with the shared ModelSelectModal).`,
    },
    {
      file: "src/app/(dashboard)/dashboard/endpoint/components/KeyAccessControls.js",
      find: `    // Same sources the combo editor feeds the picker with.`,
      replace: `    // Same sources the ModelSelectModal expects (providers + aliases).`,
      check: `    // Same sources the ModelSelectModal expects (providers + aliases).`,
    },
    {
      file: "src/app/(dashboard)/dashboard/endpoint/components/KeyAccessControls.js",
      find: `<span className="text-xs text-orange-500">No combos or models allowed — this key can call nothing.</span>`,
      replace: `<span className="text-xs text-orange-500">No models allowed — this key can call nothing.</span>`,
      check: `<span className="text-xs text-orange-500">No models allowed — this key can call nothing.</span>`,
    },
    {
      file: "src/app/(dashboard)/dashboard/endpoint/components/KeyAccessControls.js",
      find: `            Add combo or model`,
      replace: `            Add model`,
      check: `            Add model`,
    },
    {
      file: "src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js",
      find: `It will only be able to call the combos and models you add. Until you add one, it can call nothing.`,
      replace: `It will only be able to call the models you add. Until you add one, it can call nothing.`,
      check: `It will only be able to call the models you add. Until you add one, it can call nothing.`,
    },
    {
      file: "src/lib/usageStats.js",
      find: `// Combo seats reference models as "oc/<slug>"; keep just the slug so combo
// failures line up with the token rows written by the chat core.`,
      replace: `// Provider-prefixed ids arrive as "oc/<slug>"; keep just the slug so failure
// rows line up with the token rows written by the chat core.`,
      check: `// Provider-prefixed ids arrive as "oc/<slug>"; keep just the slug so failure`,
    },

    // ── stale comments that described combo routing
    {
      file: "src/sse/handlers/chat.js",
      find: `  // Claude Code marks a 1M-context request as \`<model>[1m]\`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.`,
      replace: `  // Claude Code marks a 1M-context request as \`<model>[1m]\`; the marker matches
  // no alias or provider/model pair, so it must not reach resolution.`,
      check: `  // no alias or provider/model pair, so it must not reach resolution.`,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `  // Per-key access control: a restricted key may call only its listed combos and
  // models. Checked once on the requested target, before bypass, combo expansion
  // and any credential lookup; an allowed combo grants the members it routes to.`,
      replace: `  // Per-key access control: a restricted key may call only the models in its
  // allow list. Checked once on the requested target, before bypass and any
  // credential lookup.`,
      check: `  // allow list. Checked once on the requested target, before bypass and any`,
    },
    {
      file: "src/sse/services/keyAccess.js",
      find: ` * Gate for endpoints whose \`model\` may be a combo or a model (chat, image, tts).
 * Call with the requested string BEFORE combo expansion.`,
      replace: ` * Gate for endpoints whose \`model\` is a chat/embedding model (chat, image, tts).
 * Call with the requested string before any credential lookup.`,
      check: ` * Call with the requested string before any credential lookup.`,
    },
    {
      file: "src/shared/components/ModelSelectModal.js",
      find: `      // while still being valid chat/combo targets.`,
      replace: `      // while still being valid chat targets.`,
      check: `      // while still being valid chat targets.`,
    },
  ],
};

PHASES["model-health"] = {
  title: "liveness probes: keep quiet-but-alive models, hide only confirmed-dead ones",
  patch: [
    // ── scheduler next to the catalog sync
    {
      file: "src/instrumentation.js",
      find: `    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();`,
      replace: `    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // model-health: hourly liveness probes for listed ids the Zen live list does
    // not cover (see healthCheck.js; MODEL_HEALTH=off disables).
    const { startModelHealthCheck } = await import("@/lib/modelCatalog/healthCheck.js");
    startModelHealthCheck();`,
      check: `const { startModelHealthCheck } = await import("@/lib/modelCatalog/healthCheck.js");`,
    },
    {
      file: "src/dashboardGuard.js",
      find: `  "/api/models",
`,
      replace: `  "/api/models",
  "/api/model-health",
`,
      check: `  "/api/model-health",
`,
    },

    // ── /v1/models: health-aware listing (hidden out, probe-alive orphans kept)
    {
      file: "src/app/api/v1/models/route.js",
      find: `import { getModelReality } from "@/lib/modelCatalog/liveModels.js";
`,
      replace: `import { getModelReality } from "@/lib/modelCatalog/liveModels.js";
import { getModelHealthFilter, mergeListedIds } from "@/lib/modelCatalog/healthCheck.js";
`,
      check: `import { getModelHealthFilter, mergeListedIds } from "@/lib/modelCatalog/healthCheck.js";`,
    },
    {
      file: "src/app/api/v1/models/route.js",
      find: `      const reality = await getModelReality(providerId);
      const listedModelIds = reality
        ? [
            ...mergedModelIds.filter((id) => reality.alive.has(id)),
            ...reality.live.filter((id) => !mergedModelIds.includes(id)),
          ]
        : mergedModelIds;`,
      replace: `      // model-health adds two signals: ids the probe confirmed gone are hidden,
      // and ids the probe keeps confirming alive stay listed even after both
      // catalogues dropped them (quiet upstreams stay useful).
      const reality = await getModelReality(providerId);
      const health = await getModelHealthFilter(providerId);
      const listedModelIds = mergeListedIds({ mergedIds: mergedModelIds, reality, health });`,
      check: `const listedModelIds = mergeListedIds({ mergedIds: mergedModelIds, reality, health });`,
    },

    // ── /api/models (dashboard picker): same hide/keep semantics
    {
      file: "src/app/api/models/route.js",
      find: `import { getModelReality } from "@/lib/modelCatalog/liveModels.js";
`,
      replace: `import { getModelReality } from "@/lib/modelCatalog/liveModels.js";
import { getModelHealthFilter } from "@/lib/modelCatalog/healthCheck.js";
`,
      check: `import { getModelHealthFilter } from "@/lib/modelCatalog/healthCheck.js";`,
    },
    {
      file: "src/app/api/models/route.js",
      find: `    const reality = await getModelReality("opencode");
    if (reality) {
      const present = new Set(models.map((m) => m.model));
      const kept = models.filter((m) => (m.provider !== "oc" && m.provider !== "opencode") || reality.alive.has(m.model));
      for (const id of reality.live) {
        if (present.has(id)) continue;`,
      replace: `    const reality = await getModelReality("opencode");
    const health = await getModelHealthFilter("opencode");
    if (reality || health.hidden.size || health.aliveExtras.length) {
      const alive = new Set([...(reality?.alive ?? []), ...health.aliveExtras]);
      const present = new Set(models.map((m) => m.model));
      const kept = models.filter((m) => {
        if (m.provider !== "oc" && m.provider !== "opencode") return true;
        return alive.has(m.model) && !health.hidden.has(m.model);
      });
      for (const id of [...(reality?.live ?? []), ...health.aliveExtras]) {
        if (present.has(id) || health.hidden.has(id)) continue;`,
      check: `const health = await getModelHealthFilter("opencode");`,
    },

    // ── probe rows never pollute the Usage page
    {
      file: "src/lib/usageStats.js",
      find: `export function recordUsageEvent(event = {}) {
  try {
    const underTest = process.env.VITEST || process.env.NODE_ENV === "test";`,
      replace: `export function recordUsageEvent(event = {}) {
  try {
    // model-health probes are not user traffic: never counted in the Usage page.
    if (event.probe === true) return Promise.resolve(false);

    const underTest = process.env.VITEST || process.env.NODE_ENV === "test";`,
      check: `    if (event.probe === true) return Promise.resolve(false);`,
    },
    {
      file: "open-sse/handlers/chatCore/requestDetail.js",
      find: `export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint, pool = null, label = "USAGE", silent = false }) {`,
      replace: `export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint, pool = null, probe = false, label = "USAGE", silent = false }) {`,
      check: `pool = null, probe = false, label = "USAGE"`,
    },
    {
      file: "open-sse/handlers/chatCore/requestDetail.js",
      find: `  recordUsageEvent({ ok: true, provider, model, pool, connectionId, endpoint, tokens });`,
      replace: `  recordUsageEvent({ ok: true, provider, model, pool, connectionId, endpoint, tokens, probe });`,
      check: `recordUsageEvent({ ok: true, provider, model, pool, connectionId, endpoint, tokens, probe });`,
    },
    {
      file: "open-sse/handlers/chatCore/nonStreamingHandler.js",
      find: `pool: clientRawRequest?._poolName || null, silent: true });`,
      replace: `pool: clientRawRequest?._poolName || null, probe: clientRawRequest?._probe === true, silent: true });`,
      check: `probe: clientRawRequest?._probe === true, silent: true });`,
    },
    {
      file: "open-sse/handlers/chatCore/sseToJsonHandler.js",
      find: `pool: clientRawRequest?._poolName || null, silent: true });`,
      replace: `pool: clientRawRequest?._poolName || null, probe: clientRawRequest?._probe === true, silent: true });`,
      check: `probe: clientRawRequest?._probe === true, silent: true });`,
      allowMultiple: true,
    },
    {
      file: "open-sse/handlers/chatCore/streamingHandler.js",
      find: `pool: clientRawRequest?._poolName || null, label: "STREAM USAGE", silent: true });`,
      replace: `pool: clientRawRequest?._poolName || null, probe: clientRawRequest?._probe === true, label: "STREAM USAGE", silent: true });`,
      check: `probe: clientRawRequest?._probe === true, label: "STREAM USAGE"`,
    },

    // ── chat handler: probe marker + suspect hook on failed real traffic
    {
      file: "src/sse/handlers/chat.js",
      find: `import { recordUsageEvent } from "@/lib/usageStats.js";
`,
      replace: `import { recordUsageEvent } from "@/lib/usageStats.js";
import { markModelSuspect } from "@/lib/modelCatalog/healthCheck.js";
`,
      check: `import { markModelSuspect } from "@/lib/modelCatalog/healthCheck.js";`,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `      headers: Object.fromEntries(request.headers.entries())
    };
  }
`,
      replace: `      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // model-health: probes are marked so they never show up as Usage rows.
  if (request?.headers?.get("x-9r-probe") === "1") clientRawRequest._probe = true;
`,
      check: `if (request?.headers?.get("x-9r-probe") === "1") clientRawRequest._probe = true;`,
    },
    {
      file: "src/sse/handlers/chat.js",
      find: `        reason: result.status ? String(result.status) : "transport",
        endpoint: clientRawRequest?.endpoint || null,
      });
    }
`,
      replace: `        reason: result.status ? String(result.status) : "transport",
        endpoint: clientRawRequest?.endpoint || null,
        probe: clientRawRequest?._probe === true,
      });
      // model-health: a 400/404 is only a suspicion — request a probe (with
      // canary confirmation) instead of judging the model on one failure.
      if (!clientRawRequest?._probe && (result.status === 400 || result.status === 404)) {
        markModelSuspect(provider, model);
      }
    }
`,
      check: `markModelSuspect(provider, model);`,
    },
  ],
};

function cmdAudit() {
  // Guards against the one bug class that silently no-ops a rule: a `check`
  // string that is already a substring of `find` (so the rule looks "applied"
  // before it ever runs). Insertion-style rules must use a check that only
  // exists AFTER the patch — or checkAbsent.
  let flagged = 0;
  for (const [id, phase] of Object.entries(PHASES)) {
    for (const rule of phase.patch || []) {
      if (!rule.find || !rule.check) continue;
      if (rule.checkAbsent) continue;
      if (rule.find.includes(rule.check)) {
        flagged++;
        console.log(c.red(`✗ ${id}: ${rule.file}`));
        console.log(c.dim(`    check ⊂ find → rule would be skipped`));
        console.log(c.dim(`    check: ${JSON.stringify(rule.check.slice(0, 80))}`));
      }
    }
  }
  if (flagged) {
    console.log(c.red(`\n${flagged} rule(s) need checkAbsent or a post-apply check.`));
    process.exitCode = 1;
  } else {
    console.log(c.green("✓ no rule has a check that is a substring of its find"));
  }
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (!cmd || cmd === "list") cmdList();
  else if (cmd === "apply") cmdApply(rest);
  else if (cmd === "verify") cmdVerify(rest);
  else if (cmd === "audit") cmdAudit();
  else {
    console.log(`usage: node scripts/lean.mjs <list|apply|verify> [phase…|all] [--dry]`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(c.red(`\n✗ ${err.message}`));
  process.exitCode = 1;
}
