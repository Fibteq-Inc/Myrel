import { z } from "zod";
import { type ChatResponse, LlmError, type ModelProvider, type ToolCall, type ToolResult, type ToolSpec, type Turn } from "./types";

/** What a tool handler hands back to the loop. `stop` ends the turn after this step. */
export type ToolOutcome = { output: string; stop?: boolean };

export type Tool<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  input: S;
  run: (input: z.infer<S>) => Promise<ToolOutcome | string> | ToolOutcome | string;
};

export function tool<S extends z.ZodType>(def: Tool<S>): Tool<S> {
  return def;
}

export function toolSpec(t: Tool): ToolSpec {
  const { $schema: _, ...parameters } = z.toJSONSchema(t.input) as Record<string, unknown>;
  return { name: t.name, description: t.description, parameters };
}

export type LoopOptions = {
  provider: ModelProvider;
  system: string;
  prompt: string;
  tools: Tool[];
  /** Model calls per turn, a guard against a model that never stops calling tools. */
  maxSteps?: number;
};

export type LoopResult = {
  steps: number;
  /** Text the model wrote outside tool calls in its final step (not shown to anyone). */
  finalText: string;
  toolCalls: ToolCall[];
  stopped: "done" | "tool_stop" | "max_steps";
};

/**
 * The agent loop: call the model, run the tools it asks for, feed the results
 * back, repeat until it stops calling tools. Tool errors go back to the model
 * as error results so it can correct itself instead of failing the turn.
 */
/**
 * Output budget for asking again when an answer was cut off. Reasoning models spend the default
 * 4096 tokens thinking before they write a tool call; the coordinator lost a two-ask message that way.
 */
export const RETRY_MAX_TOKENS = 16_384;

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const specs = opts.tools.map(toolSpec);
  const turns: Turn[] = [{ role: "user", content: opts.prompt }];
  const calls: ToolCall[] = [];
  const maxSteps = opts.maxSteps ?? 10;

  for (let step = 1; step <= maxSteps; step++) {
    let res: ChatResponse = await opts.provider.chat({ system: opts.system, turns, tools: specs });
    // A cut-off answer with no tool call would end the turn as if the model chose to do nothing.
    if (res.truncated && res.toolCalls.length === 0) {
      res = await opts.provider.chat({ system: opts.system, turns, tools: specs, maxTokens: RETRY_MAX_TOKENS });
      if (res.truncated && res.toolCalls.length === 0) {
        throw new LlmError(`The model's answer was cut off at ${RETRY_MAX_TOKENS} output tokens before it called a tool.`);
      }
    }
    turns.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls });
    if (res.toolCalls.length === 0) return { steps: step, finalText: res.text, toolCalls: calls, stopped: "done" };

    const results: ToolResult[] = [];
    let stop = false;
    for (const call of res.toolCalls) {
      calls.push(call);
      const outcome = await runTool(byName.get(call.name), call);
      results.push(outcome.result);
      stop ||= outcome.stop;
    }
    turns.push({ role: "tool", results });
    if (stop) return { steps: step, finalText: res.text, toolCalls: calls, stopped: "tool_stop" };
  }
  return { steps: maxSteps, finalText: "", toolCalls: calls, stopped: "max_steps" };
}

export async function runTool(t: Tool | undefined, call: ToolCall): Promise<{ result: ToolResult; stop: boolean }> {
  const fail = (output: string) => ({ result: { id: call.id, name: call.name, output, isError: true }, stop: false });
  if (!t) return fail(`Unknown tool "${call.name}".`);
  const parsed = t.input.safeParse(call.input);
  if (!parsed.success) return fail(`Invalid input: ${z.prettifyError(parsed.error)}`);
  try {
    const out = await t.run(parsed.data);
    const outcome = typeof out === "string" ? { output: out } : out;
    return { result: { id: call.id, name: call.name, output: outcome.output }, stop: outcome.stop ?? false };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
