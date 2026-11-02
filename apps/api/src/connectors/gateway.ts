import { wrapExternal } from "../agents/external";
import { blockedUrl } from "./client";

/** Request headers an MCP client sends that the server needs too. */
const FORWARD_REQUEST = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
/** Response headers the client needs back. */
const FORWARD_RESPONSE = ["content-type", "mcp-session-id", "mcp-protocol-version", "cache-control"];

/**
 * Passes one MCP request from the thread's agent to a remote connector, adding the connector's
 * credentials, and streams the answer back as it comes (JSON or SSE). The agent only ever holds
 * its turn token, never the connector's.
 */
export async function proxyMcp(
  request: Request,
  target: { url: string; headers: Record<string, string>; title?: string },
  fetcher: typeof fetch = fetch,
  /** Told before a tool call goes out: its answer is about to enter the agent's context. */
  onToolCall?: () => Promise<void>,
): Promise<Response> {
  const blocked = blockedUrl(target.url);
  if (blocked) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: blocked } }, { status: 502 });
  // Read here to see whether it calls a tool; sent on as the same text.
  const body = request.method === "POST" ? await request.text() : undefined;
  const calls = body !== undefined && callsTool(body);
  if (calls && onToolCall) await onToolCall().catch((err) => console.warn("marking the connector call failed", err));
  const headers = new Headers(target.headers);
  for (const name of FORWARD_REQUEST) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let upstream: Response;
  try {
    upstream = await fetcher(target.url, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });
  } catch (err) {
    const message = `Could not reach the connector: ${err instanceof Error ? err.message : String(err)}`;
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }, { status: 502 });
  }
  const out = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  // A refusal of the stored credentials is the connector's to fix in Myrel, not the agent's to log in to.
  const status = upstream.status >= 300 && upstream.status < 400 ? 502 : upstream.status;
  if (!calls || !upstream.body) return new Response(upstream.body, { status, headers: out });
  // A tool's answer is someone else's text: it reaches the agent as data (see agents/external.ts).
  const source = `connector:${target.title ?? new URL(target.url).hostname}`;
  const type = upstream.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) return new Response(upstream.body.pipeThrough(wrapEvents(source)), { status, headers: out });
  if (type.includes("json")) {
    const text = await upstream.text();
    return new Response(wrapJson(text, source), { status, headers: out });
  }
  return new Response(upstream.body, { status, headers: out });
}

/** Whether a JSON-RPC message (or batch) calls a tool. */
export function callsTool(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.some((m) => !!m && typeof m === "object" && (m as { method?: unknown }).method === "tools/call");
  } catch {
    return false;
  }
}

type Content = { type?: string; text?: unknown };

/** A JSON-RPC answer (or batch) with each tool result's text wrapped; anything else as it was. */
export function wrapJson(text: string, source: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  let changed = false;
  for (const m of messages) {
    const content = (m as { result?: { content?: unknown } } | null)?.result?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content as Content[]) {
      if (item?.type !== "text" || typeof item.text !== "string") continue;
      item.text = wrapExternal({ source, trust: "untrusted" }, item.text).text;
      changed = true;
    }
  }
  return changed ? JSON.stringify(parsed) : text;
}

/** The same for a stream of server-sent events: each `data:` line holds one JSON-RPC message. */
function wrapEvents(source: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let rest = "";
  const line = (l: string) => (l.startsWith("data:") ? `data: ${wrapJson(l.slice(5).trimStart(), source)}` : l);
  return new TransformStream({
    transform(chunk, controller) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      if (lines.length) controller.enqueue(encoder.encode(`${lines.map(line).join("\n")}\n`));
    },
    flush(controller) {
      rest += decoder.decode();
      if (rest) controller.enqueue(encoder.encode(line(rest)));
    },
  });
}
