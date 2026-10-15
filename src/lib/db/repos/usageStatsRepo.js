// Usage stats repo (fork-owned): minimal pool/token attribution written by the
// chat path and read by /api/usage-stats. One row = one upstream call (attempt).
// Reuses the upstream usageHistory table (created by the initial migration), so
// no schema change is needed; pool and fail reason live in the meta JSON column.
import { getAdapter } from "../driver.js";

export async function insertUsageRow(row) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.timestamp, row.provider, row.model, row.connectionId, row.apiKey, row.endpoint,
      row.promptTokens, row.completionTokens, 0, row.status, row.tokens, row.meta,
    ]
  );
}

export async function queryUsageTotals(since) {
  const db = await getAdapter();
  return db.get(
    `SELECT
       COUNT(*) AS attempts,
       SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS served,
       SUM(CASE WHEN status = 'ok' THEN 0 ELSE 1 END) AS failed,
       SUM(CASE WHEN status = 'ok' THEN promptTokens ELSE 0 END) AS inTokens,
       SUM(CASE WHEN status = 'ok' THEN completionTokens ELSE 0 END) AS outTokens,
       SUM(CASE WHEN status = 'ok' THEN COALESCE(json_extract(tokens, '$.cached'), 0) ELSE 0 END) AS cachedTokens
     FROM usageHistory WHERE timestamp >= ?`,
    [since]
  );
}

export async function queryUsageSlices(since) {
  const db = await getAdapter();
  return db.all(
    `SELECT
       CASE WHEN status = 'ok'
            THEN COALESCE(NULLIF(json_extract(meta, '$.pool'), ''), 'direct')
            ELSE 'Fail' END AS label,
       COUNT(*) AS n
     FROM usageHistory WHERE timestamp >= ?
     GROUP BY label ORDER BY n DESC`,
    [since]
  );
}

export async function queryUsageModels(since) {
  const db = await getAdapter();
  return db.all(
    `SELECT provider, model,
       COUNT(*) AS attempts,
       SUM(CASE WHEN status = 'ok' THEN 0 ELSE 1 END) AS fails,
       SUM(CASE WHEN status = 'ok' THEN promptTokens ELSE 0 END) AS inTokens,
       SUM(CASE WHEN status = 'ok' THEN completionTokens ELSE 0 END) AS outTokens,
       SUM(CASE WHEN status = 'ok' THEN COALESCE(json_extract(tokens, '$.cached'), 0) ELSE 0 END) AS cachedTokens,
       MAX(timestamp) AS lastAt
     FROM usageHistory WHERE timestamp >= ?
     GROUP BY provider, model ORDER BY attempts DESC`,
    [since]
  );
}

// Fail reasons per model (top reasons first), for the "which model fails" column.
export async function queryUsageFailReasons(since) {
  const db = await getAdapter();
  return db.all(
    `SELECT provider, model, COALESCE(json_extract(meta, '$.reason'), 'error') AS reason, COUNT(*) AS n
     FROM usageHistory WHERE timestamp >= ? AND status <> 'ok'
     GROUP BY provider, model, reason ORDER BY n DESC`,
    [since]
  );
}

export async function queryRecentUsage(since, limit = 30) {
  const db = await getAdapter();
  return db.all(
    `SELECT timestamp, provider, model, status, promptTokens, completionTokens, tokens, meta
     FROM usageHistory WHERE timestamp >= ?
     ORDER BY timestamp DESC LIMIT ?`,
    [since, limit]
  );
}

export async function deleteUsageBefore(cutoff) {
  const db = await getAdapter();
  return db.run(`DELETE FROM usageHistory WHERE timestamp < ?`, [cutoff]);
}
