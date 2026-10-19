import { type ChatRequest, type ChatResponse, LlmError, type ModelProvider } from "./types";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

type AnthropicMessage = { role: "user" | "assistant"; content: string | Block[] };

type AnthropicResponse = {
  content?: Block[];
  usage?: { input_tokens?: number; output_tokens?: number };
};

export type AnthropicOptions = {
  model: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
};

/** Anthropic Messages API. */
export function anthropic(opts: AnthropicOptions): ModelProvider {
  const doFetch = opts.fetch ?? fetch;
  return {
    id: "anthropic",
    model: opts.model,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const res = await doFetch(`${opts.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
          ...opts.headers,
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: req.maxTokens ?? 4096,
          system: req.system,
          messages: toMessages(req),
          tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        }),
      });
      if (!res.ok) throw new LlmError(`anthropic ${res.status}: ${(await res.text()).slice(0, 500)}`, res.status);

      const data = (await res.json()) as AnthropicResponse;
      const blocks = data.content ?? [];
      return {
        text: blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join(""),
        toolCalls: blocks.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [])),
        usage: data.usage && {
          inputTokens: data.usage.input_tokens ?? 0,
          outputTokens: data.usage.output_tokens ?? 0,
        },
      };
    },
  };
}

function toMessages(req: ChatRequest): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const turn of req.turns) {
    if (turn.role === "user") out.push({ role: "user", content: turn.content });
    else if (turn.role === "assistant") {
      const content: Block[] = [];
      if (turn.text) content.push({ type: "text", text: turn.text });
      for (const c of turn.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} });
      out.push({ role: "assistant", content });
    } else {
      out.push({
        role: "user",
        content: turn.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: r.output,
          ...(r.isError && { is_error: true }),
        })),
      });
    }
  }
  return out;
}
