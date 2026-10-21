import { reportedCost } from "./openai";

/** Response headers worth passing back to the harness; the rest describe the provider's own plumbing. */
const PASSED_HEADERS = ["content-type", "cache-control", "retry-after", "x-request-id"];

/**
 * The provider paths (under the model's base address) a harness's turn may call: inference only.
 * The key added here usually opens much more (files, batches, fine-tuning, the account), none of it
 * the turn's business.
 */
const MODEL_PATHS: Record<"openai" | "anthropic", string[]> = {
  openai: ["chat/completions"],
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
 * Anthropic's. For an OpenAI-compatible call it also reports what the call cost when the provider
 * says so: usage.cost in the last chunk of a stream, or the JSON's usage / a cost header.
 * OpenCode prices Anthropic calls itself, so those report nothing here.
 */
export async function proxyModel(
  req: Request,
  target: { url: string; apiKey: string; kind: "openai" | "anthropic"; model?: string },
  onCost: (usd: number) => Promise<void>,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
  const headers = new Headers(target.kind === "anthropic" ? { "x-api-key": target.apiKey } : { authorization: `Bearer ${target.apiKey}` });
  for (const name of KEPT_HEADERS) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const text = hasBody ? await req.text() : undefined;
  // An OpenAI-compatible call names its model in the body: only the project's model is paid for here.
  if (target.model && target.kind === "openai" && bodyModel(text) !== target.model) {
    return Response.json({ error: { message: `This turn can only use ${target.model}.` } }, { status: 403 });
  }
  const sent = text !== undefined && target.kind === "openai" ? withStreamUsage(text) : text;
  const upstream = await fetch(target.url, { method: req.method, headers, body: sent });
  const out = new Headers();
  for (const name of PASSED_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  const report = (usd: number | undefined) => {
    if (usd !== undefined && usd > 0) waitUntil(onCost(usd).catch((err) => console.error("model cost", err)));
  };

  if (!upstream.body || !upstream.ok || target.kind === "anthropic") return new Response(upstream.body, { status: upstream.status, headers: out });
  if (!(upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const text = await upstream.text();
    let usage: Record<string, unknown> | undefined;
    try {
      usage = (JSON.parse(text) as { usage?: Record<string, unknown> }).usage;
    } catch {}
    report(reportedCost(usage, upstream.headers).costUsd);
    return new Response(text, { status: upstream.status, headers: out });
  }

  const scan = streamCostScanner();
  const body = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        scan.push(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        report(scan.cost() ?? reportedCost(undefined, upstream.headers).costUsd);
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

/** Watches an SSE stream's data lines for the usage object a provider sends with the last chunk. */
export function streamCostScanner() {
  const decoder = new TextDecoder();
  let rest = "";
  let found: number | undefined;
  const line = (l: string) => {
    if (!l.startsWith("data:") || !l.includes('"usage"')) return;
    try {
      const usage = (JSON.parse(l.slice(5)) as { usage?: Record<string, unknown> }).usage;
      const cost = reportedCost(usage ?? undefined).costUsd;
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
  };
}
