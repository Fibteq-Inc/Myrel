import { describe, expect, it } from "vitest";
import { cloudHarness } from "../src/sandbox/backend";

describe("cloudHarness", () => {
  it("runs the project's cloud CLI when its model suits it", () => {
    expect(cloudHarness("claude", { kind: "anthropic" })).toEqual({ id: "claude-code", title: "Claude Code" });
    // An OpenAI-compatible model whose provider also speaks Anthropic's API (Fireworks).
    expect(cloudHarness("claude", { kind: "openai", messages: true })).toEqual({ id: "claude-code", title: "Claude Code" });
    expect(cloudHarness("codex", { kind: "openai" })).toEqual({ id: "codex", title: "Codex" });
    expect(cloudHarness("opencode", { kind: "anthropic" })).toEqual({ id: "opencode", title: "OpenCode" });
  });

  it("falls back to OpenCode, saying why, when the model does not suit the CLI", () => {
    expect(cloudHarness("claude", { kind: "openai" })).toMatchObject({ id: "opencode", note: expect.stringContaining("speaks Anthropic's API") });
    expect(cloudHarness("codex", { kind: "anthropic" })).toMatchObject({ id: "opencode", note: expect.stringContaining("OpenAI-compatible") });
  });
});
