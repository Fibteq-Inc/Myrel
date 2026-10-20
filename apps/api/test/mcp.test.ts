import { describe, expect, it } from "vitest";
import { z } from "zod";
import { handleMcp, tool } from "../src/llm";

const echo = tool({ name: "echo", description: "Echo text.", input: z.object({ text: z.string().min(1) }), run: ({ text }) => text });
const info = { name: "altair", version: "1" };

describe("handleMcp", () => {
  it("lists tools with their JSON schema and calls them", async () => {
    const list = (await handleMcp([echo], info, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: { name: string; inputSchema: { properties: object } }[] };
    };
    expect(list.result.tools[0]).toMatchObject({ name: "echo", inputSchema: { properties: { text: { type: "string" } } } });
    expect(await handleMcp([echo], info, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: "hi" }], isError: false },
    });
  });

  it("reports bad input as a tool error and unknown methods as JSON-RPC errors", async () => {
    const bad = (await handleMcp([echo], info, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: {} } })) as {
      result: { isError: boolean };
    };
    expect(bad.result.isError).toBe(true);
    expect(await handleMcp([echo], info, { jsonrpc: "2.0", id: 4, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
    expect(await handleMcp([echo], info, { nope: true })).toMatchObject({ error: { code: -32600 } });
  });

  it("answers notifications with nothing and batches with an array", async () => {
    expect(await handleMcp([echo], info, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const batch = await handleMcp([echo], info, [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 5, method: "ping" },
    ]);
    expect(batch).toEqual([{ jsonrpc: "2.0", id: 5, result: {} }]);
  });
});
