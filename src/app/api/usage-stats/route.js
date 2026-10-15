import { NextResponse } from "next/server";
import { getUsageOverview } from "@/lib/usageStats.js";

export const dynamic = "force-dynamic";

// GET /api/usage-stats?range=today|24h|7d|30d|60d
// Fork-owned (pool-usage phase): totals, pool slices (incl. Fail), per-model
// stats and the latest upstream calls recorded by src/lib/usageStats.js.
export async function GET(request) {
  try {
    const range = new URL(request.url).searchParams.get("range") || undefined;
    const data = await getUsageOverview(range);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err?.message || "Failed to load usage stats" },
      { status: 500 }
    );
  }
}
