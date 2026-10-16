import { NextResponse } from "next/server";
import { runHealthCheck } from "@/lib/modelCatalog/healthCheck.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// POST /api/model-health/check - run the liveness probe pass now (dashboard
// auth, same as the other dashboard APIs). ?model=<id> (repeatable) probes
// only those ids, which is how a manual check on one model stays cheap.
export async function POST(request) {
  try {
    const url = new URL(request.url);
    const only = url.searchParams.getAll("model").filter(Boolean);
    const result = await runHealthCheck({ only: only.length ? only : null });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
