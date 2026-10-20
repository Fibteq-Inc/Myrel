/**
 * Provider-neutral chat types. Each provider adapter maps these onto its own wire
 * format, so the agent loop never sees OpenAI- or Anthropic-specific shapes.
 */

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  parameters: Record<string, unknown>;
};

export type ToolCall = { id: string; name: string; input: unknown };

export type ToolResult = { id: string; name: string; output: string; isError?: boolean };

export type Turn =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

export type ChatRequest = {
  system: string;
  turns: Turn[];
  tools: ToolSpec[];
  maxTokens?: number;
};

/** inputTokens counts every input token, cached ones included. */
export type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number };

export type ChatResponse = {
  text: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  /** The model the provider reports answering, which a router may pick per call. */
  model?: string;
  /** What the call cost in US dollars, when the provider says so in its response. */
  costUsd?: number;
};

export interface ModelProvider {
  /** Provider id, e.g. "fireworks". */
  readonly id: string;
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
