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
  target: { url: string; headers: Record<string, string> },
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const blocked = blockedUrl(target.url);
  if (blocked) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: blocked } }, { status: 502 });
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
      body: request.method === "POST" ? request.body : undefined,
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
  return new Response(upstream.body, { status, headers: out });
}
