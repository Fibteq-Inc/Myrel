import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runBridge } from "../src/bridge";

/** A stand-in for Myrel's MCP endpoint: stateless JSON, like apps/api's /agent-mcp. */
function fakeMyrel(answers: (body: { method: string; params?: { name?: string } }) => unknown) {
  const seen: Array<{ auth?: string; method: string }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ auth: req.headers.authorization, method: body.method });
      if (body.id === undefined) return res.writeHead(202).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answers(body) }));
    });
  });
  return { server, seen };
}

async function talk(run: Parameters<typeof runBridge>[0]["run"], messages: unknown[]) {
  const input = new PassThrough();
  const out: Array<{ id: number; result?: any; error?: any }> = [];
  const done = runBridge({ input, write: (l) => out.push(JSON.parse(l)), run, version: "0.0.0" });
  for (const m of messages) input.write(`${JSON.stringify(m)}\n`);
  input.end();
  await done;
  return out.sort((a, b) => a.id - b.id);
}

const call = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) });

describe("mcp-bridge", () => {
  it("offers no tools outside a run from Myrel", async () => {
    const out = await talk(null, [call(1, "initialize", { protocolVersion: "2025-06-18" }), call(2, "tools/list")]);
    expect(out[0]!.result.serverInfo.name).toBe("myrel");
    expect(out[1]!.result).toEqual({ tools: [] });
  });

  it("forwards to the run's servers with its token, connectors' tools under their name", async () => {
    const myrel = fakeMyrel((b) =>
      b.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "m" } }
        : b.method === "tools/list"
          ? { tools: [{ name: "reply", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: `called ${b.params?.name}` }] },
    );
    await new Promise<void>((r) => myrel.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(myrel.server.address() as AddressInfo).port}/api/agent-mcp/thr_1`;
    // A local connector: answers every request with the tool it has.
    const script = `require("readline").createInterface({input:process.stdin}).on("line",l=>{const m=JSON.parse(l);if(m.id===undefined)return;const r=m.method==="tools/list"?{tools:[{name:"query",inputSchema:{type:"object"}}]}:m.method==="tools/call"?{content:[{type:"text",text:"db "+m.params.name+" "+process.env.DB}]}:{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"db"}};process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:r})+"\\n")})`;
    try {
      const out = await talk(
        {
          token: "tok",
          servers: [
            { transport: "http", name: "myrel", url },
            { transport: "stdio", name: "db", command: process.execPath, args: ["-e", script], env: { DB: "x" } },
          ],
        },
        [call(1, "initialize", { protocolVersion: "2025-06-18" }), call(2, "tools/list"), call(3, "tools/call", { name: "reply", arguments: {} }), call(4, "tools/call", { name: "db__query", arguments: {} }), call(5, "tools/call", { name: "nope" })],
      );
      expect(out[1]!.result.tools.map((t: { name: string }) => t.name)).toEqual(["reply", "db__query"]);
      expect(out[2]!.result.content[0].text).toBe("called reply");
      expect(out[3]!.result.content[0].text).toBe("db query x");
      expect(out[4]!.error.message).toMatch(/Unknown tool/);
      expect(myrel.seen.every((s) => s.auth === "Bearer tok")).toBe(true);
      expect(myrel.seen.map((s) => s.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    } finally {
      myrel.server.close();
    }
  });
});
