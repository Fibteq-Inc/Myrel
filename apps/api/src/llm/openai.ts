import { type ChatRequest, type ChatResponse, LlmError, type ModelProvider, type ToolCall } from "./types";

type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type OpenAiResponse = {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } & Record<string, unknown>;
};

export type OpenAiCompatibleOptions = {
  id: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
};

/** Chat Completions API: OpenAI, Fireworks, OpenRouter, Groq and anything else that speaks it. */
export function openAiCompatible(opts: OpenAiCompatibleOptions): ModelProvider {
  const doFetch = opts.fetch ?? fetch;
  return {
    id: opts.id,
    model: opts.model,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const res = await doFetch(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}`, ...opts.headers },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: req.maxTokens ?? 4096,
          messages: toMessages(req),
          ...(req.tools.length > 0 && {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: "auto",
          }),
        }),
      });
      if (!res.ok) throw new LlmError(`${opts.id} ${res.status}: ${(await res.text()).slice(0, 500)}`, res.status);

      const data = (await res.json()) as OpenAiResponse;
      const message = data.choices?.[0]?.message;
      const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((c, i) => ({
        id: c.id || `call_${i}`,
        name: c.function?.name ?? "",
        input: parseArguments(c.function?.arguments),
      }));
      return {
        text: message?.content ?? "",
        toolCalls,
        usage: data.usage && {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
          cachedInputTokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
        },
        model: data.model,
        ...reportedCost(data.usage, res.headers),
      };
    },
  };
}

/** Where OpenAI-compatible APIs put a call's price: OpenRouter's usage.cost and its look-alikes. */
const USAGE_COST_KEYS = ["cost", "cost_usd", "total_cost", "total_cost_usd"];

/**
 * The call's cost when the response carries one, in the usage object or a header.
 * A LiteLLM proxy sends x-litellm-response-cost in US dollars. Fireworks' Nexus Auto
 * sends neither, so its calls are priced by the model they name (see callCostMicros).
 */
export function reportedCost(usage: Record<string, unknown> | undefined, headers: Headers = new Headers()): { costUsd?: number } {
  for (const key of USAGE_COST_KEYS) {
    const v = toUsd(usage?.[key]);
    if (v !== null) return { costUsd: v };
  }
  const v = toUsd(headers.get("x-litellm-response-cost"));
  return v === null ? {} : { costUsd: v };
}

function toUsd(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function toMessages(req: ChatRequest): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: req.system }];
  for (const turn of req.turns) {
    if (turn.role === "user") out.push({ role: "user", content: turn.content });
    else if (turn.role === "assistant") {
      out.push({
        role: "assistant",
        content: turn.text || null,
        ...(turn.toolCalls.length > 0 && {
          tool_calls: turn.toolCalls.map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
          })),
        }),
      });
    } else {
      for (const r of turn.results) out.push({ role: "tool", tool_call_id: r.id, content: r.output });
    }
  }
  return out;
}

/** Models occasionally send empty or malformed argument strings; let tool validation report it. */
function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparsed: raw };
  }
}
