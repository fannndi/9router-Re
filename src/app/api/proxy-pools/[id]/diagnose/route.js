import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { getProxyPoolById } from "@/models";
import { testProxyUrl } from "@/lib/network/proxyTest";

const execFileAsync = promisify(execFile);

// Public IP echo used to prove which path a request really leaves through.
const IP_ECHO_URL = "https://api.ipify.org";
const NET_TIMEOUT_MS = 8000;

// Tether interfaces created by Android/iOS USB tethering.
const TETHER_IFACE_RE = /^(enx|usb|rndis|ncm)/;

// The phone pool's proxy (tinyproxy) always listens on this port; the tether /
// policy-routing checks only make sense for it.
const MOBILE_POOL_PORT = "8888";

// Loopback pools map to the local proxy service that serves them, so the check
// can name the service to restart when it is down.
const LOCAL_SERVICE_BY_PORT = {
  "8888": { unit: "tinyproxy", scope: "system", label: "tinyproxy" },
  "8899": { unit: "9router-local-proxy", scope: "user", label: "9router-local-proxy" },
};

const SETUP_COMMAND = "sudo ~/Gateway/mobile-pool/setup.sh";

function check(id, label, status, detail = "", hint = "") {
  return { id, label, status, detail, hint };
}

async function run(cmd, args, timeout = 5000) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout });
    return String(stdout || "").trim();
  } catch (error) {
    return String(error?.stdout || "").trim();
  }
}

function maskProxyUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function isLoopbackUrl(raw) {
  try {
    const host = new URL(raw).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function portOf(raw) {
  try {
    return new URL(raw).port || "";
  } catch {
    return "";
  }
}

async function fetchText(url, { proxyUrl = "", timeoutMs = NET_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let dispatcher;
  try {
    if (proxyUrl) dispatcher = new ProxyAgent({ uri: proxyUrl });
    const res = await undiciFetch(url, {
      dispatcher,
      signal: controller.signal,
      headers: { "User-Agent": "9Router-diagnose" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.text()).trim();
  } finally {
    clearTimeout(timer);
    try { await dispatcher?.close?.(); } catch { /* ignore */ }
  }
}

/** Tether interfaces (name + IPv4) present on this machine. */
async function listTetherInterfaces() {
  let names = [];
  try {
    names = await readdir("/sys/class/net");
  } catch {
    return [];
  }
  const ifaces = [];
  for (const name of names) {
    if (!TETHER_IFACE_RE.test(name)) continue;
    const out = await run("ip", ["-4", "-o", "addr", "show", "dev", name]);
    const match = out.match(/inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/);
    ifaces.push({ name, ip: match ? match[1] : null, prefix: match ? match[2] : null });
  }
  return ifaces;
}

// GET /api/proxy-pools/[id]/diagnose - "Check setup" checklist (read-only, no sudo)
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const pool = await getProxyPoolById(id);
    if (!pool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const proxyUrl = String(pool.proxyUrl || "").trim();
    const loopback = isLoopbackUrl(proxyUrl);
    const checks = [];

    // 1. Pool row itself
    if (!proxyUrl) {
      checks.push(check("pool", "Pool configuration", "fail", "Pool has no proxy URL", "Edit the pool and add the proxy URL."));
    } else if (pool.isActive !== true) {
      checks.push(check("pool", "Pool configuration", "fail", "Pool is inactive", "Turn the pool on (toggle in the list)."));
    } else {
      checks.push(check("pool", "Pool configuration", "pass", `Active · ${maskProxyUrl(proxyUrl)}`));
    }

    // 2. Proxy reachability
    let proxyReachable = false;
    if (proxyUrl) {
      const probe = await testProxyUrl({ proxyUrl });
      proxyReachable = probe.ok === true;
      checks.push(
        proxyReachable
          ? check("proxy", "Proxy reachable", "pass", `${probe.status} ${probe.statusText || "OK"} · ${probe.elapsedMs} ms`)
          : check("proxy", "Proxy reachable", "fail", probe.error || `HTTP ${probe.status}`, loopback ? "Is the proxy process running? Re-run the setup command." : "Check the proxy host/port/credentials.")
      );
    }

    // 3. Exit IP proof — which route does traffic actually leave through?
    let directIp = null;
    let proxyIp = null;
    let directError = null;
    let proxyError = null;
    try {
      directIp = await fetchText(IP_ECHO_URL);
    } catch (error) {
      directError = error?.name === "AbortError" ? "timed out" : (error?.message || String(error));
    }
    if (proxyReachable) {
      try {
        proxyIp = await fetchText(IP_ECHO_URL, { proxyUrl });
      } catch (error) {
        proxyError = error?.name === "AbortError" ? "timed out" : (error?.message || String(error));
      }
    }

    if (directError && !proxyIp) {
      checks.push(check("exit-ip", "Exit IP (direct vs via proxy)", "info", `Direct check failed: ${directError}`, "No internet? The check needs a tiny request to api.ipify.org."));
    } else if (!proxyReachable) {
      checks.push(check("exit-ip", "Exit IP (direct vs via proxy)", "info", "Skipped — proxy unreachable"));
    } else if (proxyError) {
      checks.push(check("exit-ip", "Exit IP (direct vs via proxy)", "fail", `Via proxy failed: ${proxyError}`, "The proxy accepts connections but cannot reach the internet. For the mobile pool: re-run the setup command."));
    } else if (directIp && proxyIp && directIp === proxyIp) {
      checks.push(check(
        "exit-ip",
        "Exit IP (direct vs via proxy)",
        "warn",
        `Both ${directIp} — same exit`,
        "Expected for the Local (host) pool. For the mobile pool this means the phone is on Wi-Fi, the tether is down, or tinyproxy's Bind is stale — turn phone Wi-Fi off and re-run the setup command."
      ));
    } else if (directIp && proxyIp) {
      checks.push(check("exit-ip", "Exit IP (direct vs via proxy)", "pass", `direct ${directIp} · via proxy ${proxyIp} (different)`));
    }

    // 4-6. Mobile setup state (only for the phone pool: loopback + tinyproxy port)
    const isMobilePool = loopback && portOf(proxyUrl) === MOBILE_POOL_PORT;
    let tetherIp = null;
    if (isMobilePool) {
      const ifaces = await listTetherInterfaces();
      const withIp = ifaces.find((iface) => iface.ip);
      tetherIp = withIp?.ip || null;

      if (ifaces.length === 0) {
        checks.push(check("tether", "USB tether interface", "fail", "No tethered network interface found", "Enable USB tethering on the phone (phone Wi-Fi OFF), then run the setup command."));
      } else if (!withIp) {
        checks.push(check("tether", "USB tether interface", "fail", `Found ${ifaces.map((i) => i.name).join(", ")} without IPv4`, "Re-run the setup command."));
      } else {
        checks.push(check("tether", "USB tether interface", "pass", `${withIp.name} · ${withIp.ip}/${withIp.prefix}`));
      }

      const rules = await run("ip", ["rule", "show"]);
      const ruleLine = rules.split("\n").find((line) => line.includes("lookup 100"));
      if (!tetherIp) {
        checks.push(check("policy-route", "Policy route (table 100)", "info", "Waiting for a tether interface"));
      } else if (ruleLine && ruleLine.includes(tetherIp)) {
        checks.push(check("policy-route", "Policy route (table 100)", "pass", ruleLine.replace(/^\d+:\s*/, "")));
      } else {
        checks.push(check("policy-route", "Policy route (table 100)", "fail", ruleLine ? `Rule points elsewhere: ${ruleLine}` : "No rule for table 100", "The tether IP changed (new phone MAC/IP). Re-run the setup command."));
      }

      const table = await run("ip", ["route", "show", "table", "100"]);
      const defaultRoute = table.split("\n").find((line) => line.startsWith("default"));
      checks.push(defaultRoute
        ? check("gateway", "Phone gateway route", "pass", defaultRoute)
        : check("gateway", "Phone gateway route", "fail", "No default route in table 100", "Re-run the setup command."));
    }

    // 7. Local proxy service backing the pool (mobile or local)
    if (loopback) {
      const service = LOCAL_SERVICE_BY_PORT[portOf(proxyUrl)];
      if (service) {
        const active = await run("systemctl", service.scope === "user"
          ? ["--user", "is-active", service.unit]
          : ["is-active", service.unit]);
        checks.push(active === "active"
          ? check("service", `Proxy service (${service.label})`, "pass", "active")
          : check("service", `Proxy service (${service.label})`, "fail", active || "not found", service.scope === "user" ? `systemctl --user restart ${service.unit}` : `sudo systemctl restart ${service.unit}`));
      }
    }

    const failed = checks.filter((c) => c.status === "fail").length;
    const warned = checks.filter((c) => c.status === "warn").length;

    return NextResponse.json({
      pool: { id: pool.id, name: pool.name, proxyUrl: maskProxyUrl(proxyUrl), loopback },
      verdict: failed > 0 ? "fail" : warned > 0 ? "warn" : "pass",
      checks,
      setupCommand: loopback ? SETUP_COMMAND : null,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.log("Error diagnosing proxy pool:", error);
    return NextResponse.json({ error: "Failed to run the setup check" }, { status: 500 });
  }
}
