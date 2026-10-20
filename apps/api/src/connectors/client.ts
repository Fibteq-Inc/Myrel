import type { ConnectorTool } from "@myrel/protocol";

/**
 * Just enough of an MCP client to check a remote server: initialize, then tools/list, over
 * Streamable HTTP (a JSON or an SSE answer) with the connector's headers. The agent's own calls do
 * not come through here; they pass through the gateway (gateway.ts) unchanged.
 */

const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 15_000;

export type ProbeResult = { ok: true; tools: ConnectorTool[] } | { ok: false; error: string };

export async function probeConnector(url: string, headers: Record<string, string>, fetcher: typeof fetch = fetch): Promise<ProbeResult> {
  const blocked = blockedUrl(url);
  if (blocked) return { ok: false, error: blocked };
  try {
    let session: string | null = null;
    const call = async (id: number | null, method: string, params?: object) => {
      const res = await fetcher(url, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": PROTOCOL_VERSION,
          ...(session && { "mcp-session-id": session }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...(id !== null && { id }), method, ...(params && { params }) }),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      session = res.headers.get("mcp-session-id") ?? session;
      if (id === null) return null;
      if (res.status === 401 || res.status === 403) throw new Error(`The server refused the credentials (HTTP ${res.status}).`);
      if (!res.ok) throw new Error(`The server answered HTTP ${res.status}.`);
      const answer = await readAnswer(res, id);
      if (answer.error) throw new Error(`The server answered "${answer.error.message ?? "error"}".`);
      return answer.result;
    };
    await call(1, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "myrel", version: "1" },
    });
    await call(null, "notifications/initialized");
    const tools: ConnectorTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = (await call(2 + page, "tools/list", cursor ? { cursor } : {})) as { tools?: unknown[]; nextCursor?: string } | null;
      for (const t of result?.tools ?? []) {
        const tool = t as { name?: unknown; description?: unknown };
        if (typeof tool.name !== "string") continue;
        tools.push({ name: tool.name, ...(typeof tool.description === "string" && { description: tool.description.slice(0, 300) }) });
      }
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return { ok: true, tools: tools.slice(0, 200) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message.slice(0, 500) };
  }
}

type RpcAnswer = { id?: unknown; result?: unknown; error?: { message?: string } };

/** The answer to request `id`, from a JSON body or from the SSE stream the server opened for it. */
async function readAnswer(res: Response, id: number): Promise<RpcAnswer> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream")) return (await res.json()) as RpcAnswer;
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end: number;
      while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const message = JSON.parse(data) as RpcAnswer;
        if (message.id === id) return message;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new Error("The server closed the stream without answering.");
}

/**
 * Why the gateway will not call this address, or null. Only public https servers: a private or
 * local address belongs on the person's computer (a stdio connector, or their own CLI's settings).
 */
export function blockedUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a valid address.";
  }
  if (url.protocol !== "https:") return "Only https:// addresses can be connected.";
  if (url.username || url.password) return "Put credentials in a header, not in the address.";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const local = "Myrel cannot reach a private or local address. Add it as a command on your computer instead.";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return local;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
      return local;
    }
  }
  if (host.includes(":") && (host === "::1" || host === "::" || /^f[cd]/.test(host) || host.startsWith("fe80") || host.startsWith("::ffff:"))) return local;
  return null;
}
