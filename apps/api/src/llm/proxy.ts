import { reportedCost } from "./openai";
import { costMicros, type Price, priceFor } from "./pricing";

/** Response headers worth passing back to the harness; the rest describe the provider's own plumbing. */
const PASSED_HEADERS = ["content-type", "cache-control", "retry-after", "x-request-id"];

/**
 * The provider paths (under the model's base address) a harness's turn may call: inference only.
 * The key added here usually opens much more (files, batches, fine-tuning, the account), none of it
 * the turn's business.
 */
const MODEL_PATHS: Record<"openai" | "anthropic", string[]> = {
  // responses: the Responses API, the only one Codex CLI speaks.
  openai: ["chat/completions", "responses"],
  anthropic: ["v1/messages", "v1/messages/count_tokens"],
};

/** Whether a harness may make this call through the model proxy: a POST to an inference path. */
export function modelCallAllowed(kind: "openai" | "anthropic", method: string, path: string): boolean {
  return method === "POST" && MODEL_PATHS[kind].includes(path);
}

/** Request headers a harness's model call keeps; its own credentials are replaced. */
const KEPT_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta"];

/**
 * Forwards one model call from a sandboxed harness to the real provider, adding the key there so
 * it never enters the sandbox: a bearer token for an OpenAI-compatible API, x-api-key for
 * Anthropic's. For an OpenAI-compatible call it also reports what the call cost: the provider's
 * own figure when it sends one (usage.cost in the last chunk of a stream, or the JSON's usage / a
 * cost header), else the usage priced by the model the response names, as a router such as
 * Fireworks' auto picks one per call. An Anthropic call is priced from its usage the same way. This
 * count is the turn's, whatever the harness reports, so a call made around the harness (with the
 * turn's token from its shell) is counted too. A call that used tokens but cannot be priced reports
 * null, so plan limits can charge it a fallback per call.
 */
export async function proxyModel(
  req: Request,
  target: {
    url: string;
    apiKey: string;
    kind: "openai" | "anthropic";
    model?: string;
    prices?: Record<string, Price>;
    /** Keeps the turn's calls on one replica so the provider's prompt cache hits (see ChatRequest.cacheKey). */
    cacheKey?: string;
  },
  onCost: (usd: number | null) => Promise<void>,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
  const headers = new Headers(target.kind === "anthropic" ? { "x-api-key": target.apiKey } : { authorization: `Bearer ${target.apiKey}` });
  for (const name of KEPT_HEADERS) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  if (target.cacheKey && target.kind === "openai") headers.set("x-session-affinity", target.cacheKey);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const text = hasBody ? await req.text() : undefined;
  // An OpenAI-compatible call names its model in the body: only the project's model is paid for here.
  if (target.model && target.kind === "openai" && bodyModel(text) !== target.model) {
    return Response.json({ error: { message: `This turn can only use ${target.model}.` } }, { status: 403 });
  }
  // A Responses API stream ends with its usage anyway, and takes no stream_options.include_usage.
  const responses = target.kind === "openai" && /\/responses\/?$/.test(new URL(target.url).pathname);
  const sent = text !== undefined && target.kind === "openai" && !responses ? withStreamUsage(text) : text;
  const upstream = await fetch(target.url, { method: req.method, headers, body: sent });
  const out = new Headers();
  for (const name of PASSED_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  // Called once per inference that used tokens: its cost, or null when it cannot be priced.
  const report = (usd: number | undefined) => {
    if (usd === undefined || usd > 0) waitUntil(onCost(usd ?? null).catch((err) => console.error("model cost", err)));
  };

  if (!upstream.body || !upstream.ok) return new Response(upstream.body, { status: upstream.status, headers: out });
  const streamed = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  if (target.kind === "anthropic") {
    if (!streamed) {
      const text = await upstream.text();
      let parsed: { usage?: Record<string, unknown>; model?: unknown } = {};
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {}
      // count_tokens answers without usage: nothing was generated.
      if (parsed.usage) report(anthropicCost(parsed.usage, parsed.model, target.prices));
      return new Response(text, { status: upstream.status, headers: out });
    }
    const scan = anthropicStreamScanner();
    const body = upstream.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          scan.push(chunk);
          controller.enqueue(chunk);
        },
        flush() {
          const usage = scan.usage();
          if (usage) report(anthropicCost(usage, scan.model(), target.prices));
        },
      }),
    );
    return new Response(body, { status: upstream.status, headers: out });
  }
  if (!streamed) {
    const text = await upstream.text();
    let parsed: { usage?: Record<string, unknown>; model?: unknown } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {}
    if (parsed.usage) report(reportedCost(parsed.usage, upstream.headers).costUsd ?? estimatedCost(parsed.usage, parsed.model, target.prices));
    return new Response(text, { status: upstream.status, headers: out });
  }

  const scan = responses ? responsesStreamScanner() : streamCostScanner();
  const body = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        scan.push(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        const cost = scan.cost() ?? reportedCost(undefined, upstream.headers).costUsd;
        if (cost !== undefined || scan.usage()) report(cost ?? estimatedCost(scan.usage(), scan.model(), target.prices));
      },
    }),
  );
  return new Response(body, { status: upstream.status, headers: out });
}

function bodyModel(body: string | undefined): unknown {
  try {
    return (JSON.parse(body ?? "") as { model?: unknown }).model;
  } catch {
    return undefined;
  }
}

/** Asks a streamed call for its usage chunk, which is where the provider puts the cost. */
function withStreamUsage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { stream?: boolean; stream_options?: Record<string, unknown> };
    if (!parsed.stream || parsed.stream_options?.include_usage) return body;
    return JSON.stringify({ ...parsed, stream_options: { ...parsed.stream_options, include_usage: true } });
  } catch {
    return body;
  }
}

/**
 * An OpenAI-compatible usage object priced at the list price of the model that served the call:
 * Chat Completions' (prompt_tokens, completion_tokens) or the Responses API's (input_tokens, output_tokens).
 */
function estimatedCost(usage: Record<string, unknown> | undefined, model: unknown, prices: Record<string, Price> | undefined): number | undefined {
  if (!usage || typeof model !== "string" || !prices) return undefined;
  const price = priceFor(model, prices);
  if (!price) return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const details = (usage.prompt_tokens_details ?? usage.input_tokens_details) as { cached_tokens?: unknown } | undefined;
  const micros = costMicros(
    {
      inputTokens: n(usage.prompt_tokens ?? usage.input_tokens),
      outputTokens: n(usage.completion_tokens ?? usage.output_tokens),
      cachedInputTokens: n(details?.cached_tokens),
    },
    price,
  );
  return micros / 1_000_000;
}

/** An Anthropic call's cost from its usage, priced by the model the response names. */
function anthropicCost(usage: Record<string, unknown>, model: unknown, prices: Record<string, Price> | undefined): number | undefined {
  if (typeof model !== "string" || !prices) return undefined;
  const price = priceFor(model, prices);
  if (!price) return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cached = n(usage.cache_read_input_tokens);
  const inputTokens = n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + cached;
  return costMicros({ inputTokens, outputTokens: n(usage.output_tokens), cachedInputTokens: cached }, price) / 1_000_000;
}

/**
 * Follows an Anthropic message stream: message_start names the model and the input tokens,
 * message_delta carries the output tokens so far.
 */
export function anthropicStreamScanner() {
  const decoder = new TextDecoder();
  let rest = "";
  let usage: Record<string, unknown> | undefined;
  let model: string | undefined;
  const line = (l: string) => {
    if (!l.startsWith("data:") || !l.includes('"usage"')) return;
    try {
      const event = JSON.parse(l.slice(5)) as { type?: string; message?: { model?: unknown; usage?: Record<string, unknown> }; usage?: Record<string, unknown> };
      if (event.type === "message_start" && event.message?.usage) {
        if (typeof event.message.model === "string") model = event.message.model;
        usage = { ...event.message.usage };
      } else if (event.type === "message_delta" && event.usage) {
        usage = { ...usage, ...event.usage };
      }
    } catch {}
  };
  return {
    push(chunk: Uint8Array) {
      const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) line(l.trim());
    },
    usage() {
      if (rest) line(rest.trim());
      rest = "";
      return usage;
    },
    model: () => model,
  };
}

/**
 * Watches an SSE stream's data lines for the usage object a provider sends with the last chunk,
 * and the model the chunks name.
 */
export function streamCostScanner() {
  const decoder = new TextDecoder();
  let rest = "";
  let found: number | undefined;
  let lastUsage: Record<string, unknown> | undefined;
  let served: string | undefined;
  const line = (l: string) => {
    if (!l.startsWith("data:") || (!l.includes('"usage"') && served)) return;
    try {
      const chunk = JSON.parse(l.slice(5)) as { usage?: Record<string, unknown> | null; model?: unknown };
      if (!served && typeof chunk.model === "string") served = chunk.model;
      if (!chunk.usage) return;
      lastUsage = chunk.usage;
      const cost = reportedCost(chunk.usage).costUsd;
      if (cost !== undefined) found = cost;
    } catch {}
  };
  return {
    push(chunk: Uint8Array) {
      const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) line(l.trim());
    },
    cost() {
      if (rest) line(rest.trim());
      rest = "";
      return found;
    },
    /** The last usage object seen; call after cost(). */
    usage: () => lastUsage,
    /** The model the stream named. */
    model: () => served,
  };
}

/**
 * Follows a Responses API stream: its last event (response.completed, or response.incomplete when
 * it was cut short) carries the whole response with the model that served it and its usage.
 * Same shape as `streamCostScanner`.
 */
export function responsesStreamScanner() {
  const decoder = new TextDecoder();
  let rest = "";
  let found: number | undefined;
  let lastUsage: Record<string, unknown> | undefined;
  let served: string | undefined;
  const line = (l: string) => {
    if (!l.startsWith("data:") || !l.includes('"usage"')) return;
    try {
      const event = JSON.parse(l.slice(5)) as { response?: { model?: unknown; usage?: Record<string, unknown> | null } };
      const usage = event.response?.usage;
      if (!usage) return;
      lastUsage = usage;
      if (typeof event.response?.model === "string") served = event.response.model;
      const cost = reportedCost(usage).costUsd;
      if (cost !== undefined) found = cost;
    } catch {}
  };
  return {
    push(chunk: Uint8Array) {
      const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) line(l.trim());
    },
    cost() {
      if (rest) line(rest.trim());
      rest = "";
      return found;
    },
    usage: () => lastUsage,
    model: () => served,
  };
}
