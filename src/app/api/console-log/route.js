import { NextResponse } from "next/server";
import { clearConsoleLogs, getConsoleLogs, initConsoleLogCapture } from "@/lib/consoleLogBuffer";

initConsoleLogCapture();

// Lean fork: the SSE stream below is what the dashboard uses; GET/DELETE keep
// the classic API available for scripts. Restored from upstream after the
// cosmetics phase deleted the /api/translator tree.
export async function GET() {
  try {
    const logs = getConsoleLogs();
    return NextResponse.json({ success: true, logs });
  } catch (error) {
    console.error("Error getting console logs:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    clearConsoleLogs();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error clearing console logs:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
