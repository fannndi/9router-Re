// Eagerly import every translator so register() side-effects run under ESM/vitest.
// translator/index.js uses require() (bundler-only) which no-ops in vitest → import directly.
//
// Lean fork: only the pairs reachable from the kept client formats
// (openai / claude / gemini / openai-responses) and the OpenCode provider
// targets (openai, claude for union-alpha, openai-responses for muse-spark)
// remain registered.
import "../../open-sse/translator/request/claude-to-openai.js";
import "../../open-sse/translator/request/openai-to-claude.js";
import "../../open-sse/translator/request/gemini-to-openai.js";
import "../../open-sse/translator/request/openai-responses.js";
import "../../open-sse/translator/response/claude-to-openai.js";
import "../../open-sse/translator/response/openai-to-claude.js";
import "../../open-sse/translator/response/openai-responses.js";
