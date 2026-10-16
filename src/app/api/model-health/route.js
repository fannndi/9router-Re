import { NextResponse } from "next/server";
import { listModelHealth } from "@/lib/db/repos/modelHealthRepo.js";
import { getLiveModelIds } from "@/lib/modelCatalog/liveModels.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/model-health - probe state per model (model-health phase).
export async function GET() {
  try {
    const [rows, live] = await Promise.all([listModelHealth(), getLiveModelIds("opencode")]);
    const liveSet = new Set(live ?? []);
    const n = Number(process.env.MODEL_HEALTH_STRIKES);
    const threshold = Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
    return NextResponse.json(
      {
        threshold,
        models: rows.map((row) => ({
          model: row.modelId,
          status: row.hidden ? "hidden" : row.lastStatus || "unknown",
          strikes: row.strikes || 0,
          hidden: !!row.hidden,
          inLive: liveSet.has(row.modelId),
          lastCheckedAt: row.lastCheckedAt || null,
          lastAliveAt: row.lastAliveAt || null,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
