// Minimal boot service. The fork has no tunnel, Tailscale or MITM to resume,
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
