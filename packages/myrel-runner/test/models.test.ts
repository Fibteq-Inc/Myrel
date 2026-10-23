import { describe, expect, it } from "vitest";
import { ADAPTERS, modelFlags, parseClaudeHelp, parseCodexModels, parseModelLines } from "../src/clis";

describe("model lists", () => {
  it("reads Claude Code's aliases and effort levels from its help", () => {
    const help = `  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.`;
    const efforts = ["low", "medium", "high", "xhigh", "max"];
    expect(parseClaudeHelp(help)).toEqual([
      { id: "fable", name: "Fable", efforts },
      { id: "opus", name: "Opus", efforts },
      { id: "sonnet", name: "Sonnet", efforts },
      { id: "haiku", name: "Haiku", efforts: [] },
    ]);
    expect(parseClaudeHelp("Usage: claude [options]")).toBeUndefined();
  });

  it("keeps each Codex model's own reasoning levels and leaves hidden ones out", () => {
    const json = JSON.stringify({
      models: [
        { slug: "gpt-6-sol", display_name: "GPT-6-Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], visibility: "list" },
        { slug: "codex-auto-review", display_name: "Review", supported_reasoning_levels: [{ effort: "low" }], visibility: "hide" },
        { slug: "gpt-mini", display_name: "GPT Mini", supported_reasoning_levels: [], visibility: "list" },
      ],
    });
    expect(parseCodexModels(json)).toEqual([
      { id: "gpt-6-sol", name: "GPT-6-Sol", efforts: ["low", "high"] },
      { id: "gpt-mini", name: "GPT Mini", efforts: [] },
    ]);
    expect(parseCodexModels("not json")).toBeUndefined();
  });

  it("reads one model per line, with or without a name", () => {
    const agy = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n";
    expect(parseModelLines(agy)).toEqual([
      { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", efforts: [] },
      { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", efforts: [] },
    ]);
    expect(parseModelLines("Available models:\n\nauto - Auto\nanthropic/claude-sonnet-5-5\n")).toEqual([
      { id: "auto", name: "Auto", efforts: [] },
      { id: "anthropic/claude-sonnet-5-5", name: "anthropic/claude-sonnet-5-5", efforts: [] },
    ]);
    expect(parseModelLines("")).toBeUndefined();
  });
});

describe("model flags", () => {
  it("passes the model and effort the way each CLI takes them", () => {
    expect(modelFlags(ADAPTERS.claude, { model: "opus", effort: "high" })).toEqual(["--model", "opus", "--effort", "high"]);
    expect(modelFlags(ADAPTERS.codex, { model: "gpt-6-sol", effort: "xhigh" })).toEqual(["-m", "gpt-6-sol", "-c", 'model_reasoning_effort="xhigh"']);
    expect(modelFlags(ADAPTERS.codex, { effort: "low" })).toEqual(["-c", 'model_reasoning_effort="low"']);
    expect(modelFlags(ADAPTERS.antigravity, { model: "gemini-3.8-flash-low", effort: "high" })).toEqual(["--model", "gemini-3.8-flash-low"]);
    expect(modelFlags(ADAPTERS.hermes, { model: "x" })).toEqual([]);
    expect(modelFlags(ADAPTERS.claude, undefined)).toEqual([]);
  });

  it("drops anything that is not a plain name, as Windows runs the CLI through a shell", () => {
    expect(modelFlags(ADAPTERS.claude, { model: "opus & calc", effort: "high" })).toEqual(["--effort", "high"]);
    expect(modelFlags(ADAPTERS.claude, { model: "-p", effort: '"x"' })).toEqual([]);
  });

  it("puts them where the CLI reads its own flags", () => {
    const extra = modelFlags(ADAPTERS.codex, { model: "gpt-6-sol" });
    expect(ADAPTERS.codex.args({ access: "edit", resume: "s-1", extra }).slice(-5)).toEqual(["-m", "gpt-6-sol", "resume", "s-1", "-"]);
  });
});
