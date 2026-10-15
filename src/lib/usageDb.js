// Stub: usage tracking removed in this fork (see scripts/lean.mjs).
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
