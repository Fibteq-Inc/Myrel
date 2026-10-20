import { runTool, type Tool, toolSpec } from "./loop";

/** MCP protocol versions this server speaks; it answers with the client's when it knows it. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

export type McpServerInfo = { name: string; version: string; instructions?: string };

/**
 * A minimal, stateless MCP server over Streamable HTTP: one JSON-RPC message
 * per POST, answered with one JSON response (no SSE). Enough for coding CLIs
 * such as Claude Code to list and call Altair's tools. Returns null for
 * notifications, which get an empty 202.
 */
export async function handleMcp(tools: Tool[], info: McpServerInfo, body: unknown): Promise<object | null> {
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map((m) => handleMcp(tools, info, m)))).filter((a) => a !== null);
    return answers.length ? answers : null;
  }
  const msg = body as Partial<JsonRpcRequest> | null;
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(null, -32600, "Invalid request");
  }
  const id = msg.id ?? null;
  // Notifications (no id) need no answer.
  if (msg.id === undefined) return null;

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return result(id, {
        protocolVersion: typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, version: info.version },
        ...(info.instructions && { instructions: info.instructions }),
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, {
        tools: tools.map((t) => {
          const spec = toolSpec(t);
          return { name: spec.name, description: spec.description, inputSchema: spec.parameters };
        }),
      });
    case "tools/call": {
      const name = msg.params?.name;
      if (typeof name !== "string") return rpcError(id, -32602, "Missing tool name");
      const t = tools.find((x) => x.name === name);
      if (!t) return rpcError(id, -32602, `Unknown tool "${name}"`);
      const { result: out } = await runTool(t, { id: String(id), name, input: msg.params?.arguments ?? {} });
      return result(id, { content: [{ type: "text", text: out.output }], isError: out.isError ?? false });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

const result = (id: string | number | null, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const rpcError = (id: string | number | null, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
