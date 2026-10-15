#!/usr/bin/env node
// Upsert a proxy pool in the local 9Router DB — no dashboard login needed.
//
// Used by mobile-pool/setup.sh after the tether is (re)configured, so the
// phone pool is created/updated automatically (URL, chain order, strict flag)
// instead of being pasted into the dashboard by hand.
//
// Talks to data.sqlite directly (same columns as src/lib/db/repos/proxyPoolsRepo.js:
// id, isActive, testStatus, data JSON, createdAt, updatedAt) so it can run as a
// plain node script without the app's "@/" alias loader.
//
// Usage:
//   node scripts/ensure-pool.mjs --name "Mobile (phone tether)" \
//     --url "http://user:pass@127.0.0.1:8888" [--order 2] [--strict] [--inactive] [--json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function arg(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const name = (arg("--name") || "").trim();
const url = (arg("--url") || "").trim();
const order = Number(arg("--order", "0"));
const strict = process.argv.includes("--strict");
const inactive = process.argv.includes("--inactive");
const asJson = process.argv.includes("--json");

if (!name || !url) {
  console.error('usage: node scripts/ensure-pool.mjs --name "<name>" --url "<proxy url>" [--order N] [--strict] [--inactive] [--json]');
  process.exit(2);
}

const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
const dbFile = path.join(dataDir, "db", "data.sqlite");
if (!fs.existsSync(dbFile)) {
  console.error(`error: database not found at ${dbFile} — start 9Router once so it creates the DB.`);
  process.exit(1);
}

const db = new DatabaseSync(dbFile);
db.exec("PRAGMA busy_timeout = 5000");

const parse = (raw, fallback) => {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const rows = db.prepare("SELECT id, isActive, testStatus, data, createdAt, updatedAt FROM proxyPools").all();
const pools = rows.map((row) => ({ ...parse(row.data, {}), id: row.id, isActive: row.isActive === 1 || row.isActive === true }));
const existing = pools.find((pool) => (pool.name || "") === name);

const now = new Date().toISOString();
let pool;
let action;

if (existing) {
  const merged = {
    ...existing,
    proxyUrl: url,
    isActive: !inactive,
    strictProxy: strict,
    ...(order > 0 ? { failoverOrder: Math.floor(order) } : {}),
    updatedAt: now,
  };
  const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = merged;
  db.prepare(
    `UPDATE proxyPools SET isActive = ?, testStatus = ?, data = ?, updatedAt = ? WHERE id = ?`
  ).run(isActive === false ? 0 : 1, testStatus ?? null, JSON.stringify(rest), now, id);
  pool = merged;
  action = "updated";
} else {
  pool = {
    id: crypto.randomUUID(),
    name,
    proxyUrl: url,
    noProxy: "",
    type: "http",
    isActive: !inactive,
    strictProxy: strict,
    ...(order > 0 ? { failoverOrder: Math.floor(order) } : {}),
    testStatus: "unknown",
    lastTestedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = pool;
  db.prepare(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)`
  ).run(id, isActive === false ? 0 : 1, testStatus ?? null, JSON.stringify(rest), createdAt, updatedAt);
  action = "created";
}

db.close();

if (asJson) console.log(JSON.stringify({ action, pool }));
else console.log(`${action} pool "${name}" (${pool.id}) → ${url}${order > 0 ? ` · order #${order}` : ""}${strict ? " · strict" : ""}`);
