// Zen free-tier limits pinned by the zen-caps phase (values verbatim from
// models.dev's `opencode` provider, checked 2026-10-16). Guards against the
// generic patterns re-sizing these ids: `*step-*` said 128k, `*deepseek*`/
// `*mimo*` said 1M for variants that are capped at 200k.
import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

const LIMITS = [
  ["step-5-preview-free", 1000000, 65536],
  ["nemotron-3.5-super-vl-free", 1048576, 131072],
  ["nemotron-3.5-lightning-free", 262144, 262144],
  ["cat-jam-free", 1048576, 131072],
  ["mimo-v2.6-flash-free", 200000, 32000],
  ["deepseek-v4.1-flash-free", 200000, 32000],
  ["big-pickle", 200000, 32000],
  ["space-bunny-free", 1048576, 524288],
  ["muse-spark-1.2-contributor-free", 1048576, 131072],
  ["muse-spark-1.3-contributor-free", 1048576, 131072],
  ["longcat-2.5-preview-free", 1000000, 131072],
];

describe("OpenCode Free (Zen) limits", () => {
  it.each(LIMITS)("%s resolves to %i ctx / %i out", (id, contextWindow, maxOutput) => {
    expect(getCapabilitiesForModel("opencode", id)).toMatchObject({ contextWindow, maxOutput });
  });

  it("keeps the flags the patterns used to resolve (wire behaviour unchanged)", () => {
    expect(getCapabilitiesForModel("opencode", "step-5-preview-free")).toMatchObject({
      reasoning: true,
      thinkingFormat: "step",
    });
    expect(getCapabilitiesForModel("opencode", "mimo-v2.6-flash-free")).toMatchObject({
      vision: true,
      audioInput: true,
      videoInput: true,
      reasoning: true,
      thinkingFormat: "deepseek",
    });
    expect(getCapabilitiesForModel("opencode", "deepseek-v4.1-flash-free")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "deepseek",
      thinkingEffortSupported: true,
    });
  });

  it("does not bleed into the non-free family ids", () => {
    expect(getCapabilitiesForModel("opencode", "deepseek-v4.1-flash")).toMatchObject({
      contextWindow: 1000000,
      maxOutput: 384000,
    });
    expect(getCapabilitiesForModel("opencode", "mimo-v2.6-flash").contextWindow).toBe(1048576);
  });
});
