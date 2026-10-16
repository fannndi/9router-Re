export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // model-health: hourly liveness probes for listed ids the Zen live list does
    // not cover (see healthCheck.js; MODEL_HEALTH=off disables).
    const { startModelHealthCheck } = await import("@/lib/modelCatalog/healthCheck.js");
    startModelHealthCheck();
  }
}
