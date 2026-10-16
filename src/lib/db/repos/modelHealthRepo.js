// model-health phase: liveness/probe state for the fetch-owned provider (oc).
// Stored in the kv table under scope `modelHealth` (key = model id) — the kv
// table already exists, so no migration is involved. A row is the gateway's
// memory of a model it has shown to the client: it lets a still-working model
// survive even after both catalogues (Zen live + models.dev copy) drop it.
import { makeKv } from "../helpers/kvStore.js";

const kv = makeKv("modelHealth");

export async function getModelHealth(modelId) {
  return (await kv.get(modelId)) || null;
}

export async function listModelHealth() {
  const all = await kv.getAll();
  return Object.entries(all)
    .map(([modelId, data]) => ({ modelId, ...(data || {}) }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/** Merge `patch` over the existing row (strikes/hidden/last* are all optional). */
export async function upsertModelHealth(modelId, patch) {
  const prev = (await kv.get(modelId)) || {};
  const next = { ...prev, ...patch };
  await kv.set(modelId, next);
  return { modelId, ...next };
}

export async function deleteModelHealth(modelId) {
  await kv.remove(modelId);
}
