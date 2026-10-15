// Fixes for agent clients (Claude Code) driving non-Anthropic upstreams:
// - the client's thinking `display` is kept on Claude-format upstreams
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { selectAnthropicBeta } from "../../open-sse/providers/shared.js";
import { hoistToolResultImages } from "../../open-sse/translator/formats/claude.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const screenshotTurn = (extraTools = []) => ({
  tools: [
    { name: "mcp__browser__computer", description: "browser", input_schema: { type: "object", properties: {} } },
    ...extraTools,
  ],
  messages: [
    { role: "user", content: "take a screenshot" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__browser__computer", input: { action: "screenshot" } }] },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [
          { type: "text", text: "Successfully captured screenshot (1x1, png)" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
        ],
      }],
    },
  ],
});

describe("tool-result images reach OpenAI-format upstreams", () => {
  it("emits the tool message text and a follow-up user message carrying the image", () => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "gpt-x", screenshotTurn(), true, null, "openai");
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("toolu_1");
    expect(toolMsg.content).toBe("Successfully captured screenshot (1x1, png)");
    expect(toolMsg.content).not.toContain(PNG);
    const follow = out.messages[out.messages.indexOf(toolMsg) + 1];
    expect(follow.role).toBe("user");
    const image = follow.content.find((p) => p.type === "image_url");
    expect(image.image_url.url).toBe(`data:image/png;base64,${PNG}`);
    expect(follow.content.find((p) => p.type === "text").text).toContain("toolu_1");
  });

  it("does not dump base64 into a tool message that had no text", () => {
    const body = screenshotTurn();
    body.messages[2].content[0].content = [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }];
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "gpt-x", body, true, null, "openai");
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg.content).toBe("");
    expect(out.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"))).toBe(true);
  });

  it("leaves text-only tool results exactly as before", () => {
    const body = screenshotTurn();
    body.messages[2].content[0].content = "plain result";
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "gpt-x", body, true, null, "openai");
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg.content).toBe("plain result");
    expect(out.messages[out.messages.length - 1]).toBe(toolMsg);
  });
});

describe("thinking display is preserved for Claude-format upstreams", () => {
  it("keeps display on adaptive thinking", () => {
    const body = { model: "claude-sonnet-5", thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" }, messages: [] };
    applyThinking(FORMATS.CLAUDE, "claude-sonnet-5", body, "claude");
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("keeps display on budget thinking and omits it when the client sent none", () => {
    const withDisplay = { model: "claude-haiku-4-5-20251001", thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: "low" }, messages: [] };
    applyThinking(FORMATS.CLAUDE, "claude-haiku-4-5-20251001", withDisplay, "claude");
    expect(withDisplay.thinking.type).toBe("enabled");
    expect(withDisplay.thinking.display).toBe("omitted");

    const without = { model: "claude-sonnet-5", thinking: { type: "adaptive" }, output_config: { effort: "high" }, messages: [] };
    applyThinking(FORMATS.CLAUDE, "claude-sonnet-5", without, "claude");
    expect(without.thinking).toEqual({ type: "adaptive" });
  });
});

describe("redact-thinking beta follows the client's display request", () => {
  it("keeps redact-thinking by default and drops it for summarized display", () => {
    expect(selectAnthropicBeta("claude-sonnet-5")).toContain("redact-thinking-2026-02-12");
    expect(selectAnthropicBeta("claude-sonnet-5", { thinking: { type: "adaptive", display: "omitted" } })).toContain("redact-thinking-2026-02-12");
    const summarized = selectAnthropicBeta("claude-sonnet-5", { thinking: { type: "adaptive", display: "summarized" } });
    expect(summarized).not.toContain("redact-thinking-2026-02-12");
    expect(summarized).toContain("interleaved-thinking-2025-05-14");
    expect(summarized).toContain("effort-2025-11-24");
  });
});

describe("tool-result images reach Anthropic-compatible upstreams", () => {
  it("hoists a tool_result image into the same user turn after the results", () => {
    const body = screenshotTurn();
    const out = hoistToolResultImages(body);
    const user = out.messages[2];
    expect(user.content[0].type).toBe("tool_result");
    expect(user.content[0].content.every((c) => c.type !== "image")).toBe(true);
    expect(user.content.some((c) => c.type === "image" && c.source?.data === PNG)).toBe(true);
    expect(user.content.find((c) => c.type === "text" && /toolu_1/.test(c.text))).toBeTruthy();
    // No image: untouched object identity.
    const plain = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] }] };
    expect(hoistToolResultImages(plain)).toBe(plain);
  });
});
