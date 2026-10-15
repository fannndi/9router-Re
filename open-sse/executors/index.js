// Lean fork: OpenCode Free + the generic OpenAI/Anthropic-compatible executor
// (see scripts/lean.mjs). getExecutor() falls back to DefaultExecutor.
import { OpenCodeExecutor } from "./opencode.js";
import { DefaultExecutor } from "./default.js";

const executors = {
  opencode: new OpenCodeExecutor(),
};

const defaultCache = new Map();

export function getExecutor(provider) {
  if (executors[provider]) return executors[provider];
  if (!defaultCache.has(provider)) defaultCache.set(provider, new DefaultExecutor(provider));
  return defaultCache.get(provider);
}

export function hasSpecializedExecutor(provider) {
  return !!executors[provider];
}

export { BaseExecutor } from "./base.js";
export { DefaultExecutor } from "./default.js";
export { OpenCodeExecutor } from "./opencode.js";
