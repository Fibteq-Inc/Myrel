import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyModel, streamCostScanner } from "../src/llm";

afterEach(() => vi.unstubAllGlobals());

const enc = new TextEncoder();

function run(upstream: Response, body: object, kind: "openai" | "anthropic" = "openai") {
  const seen: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return upstream;
  });
  const costs: number[] = [];
  const waits: Promise<unknown>[] = [];
  const req = new Request("https://myrel.test/api/agent-mcp/t/model/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer turn-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = proxyModel(req, { url: "https://up.test/v1/chat/completions", apiKey: "real-key", kind }, async (usd) => void costs.push(usd), (p) => void waits.push(p));
  return { res, seen, costs, settle: () => Promise.all(waits) };
}

describe("proxyModel", () => {
  it("swaps the turn's token for the real key and reads a JSON call's cost header", async () => {
    const upstream = Response.json({ usage: { prompt_tokens: 1 } }, { headers: { "x-litellm-response-cost": "0.002", "x-litellm-key-spend": "5" } });
    const { res, seen, costs, settle } = run(upstream, { model: "firerouter/opus", messages: [] });
    const out = await res;
    await settle();
    expect(seen[0]!.url).toBe("https://up.test/v1/chat/completions");
    expect(new Headers(seen[0]!.init.headers).get("authorization")).toBe("Bearer real-key");
    expect(out.headers.get("x-litellm-key-spend")).toBeNull();
    expect(await out.json()).toEqual({ usage: { prompt_tokens: 1 } });
    expect(costs).toEqual([0.002]);
  });

  it("passes a stream through as is, asks for its usage chunk and takes the cost from it", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":15,"cost":0.00002725}}\n\ndata: [DONE]\n\n';
    const upstream = new Response(
      new ReadableStream({
        start(c) {
          // Split mid-line, as the network does.
          c.enqueue(enc.encode(sse.slice(0, 60)));
          c.enqueue(enc.encode(sse.slice(60)));
          c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const { res, seen, costs, settle } = run(upstream, { model: "m", stream: true, messages: [] });
    const out = await res;
    expect(await out.text()).toBe(sse);
    await settle();
    expect(JSON.parse(seen[0]!.init.body as string).stream_options).toEqual({ include_usage: true });
    expect(costs).toEqual([0.00002725]);
  });

  it("gives Anthropic its key as x-api-key, leaves the body alone and reports no cost", async () => {
    const upstream = Response.json({ usage: { input_tokens: 1, cost: 9 } }, { headers: { "x-litellm-response-cost": "9" } });
    const { res, seen, costs, settle } = run(upstream, { model: "claude", stream: true }, "anthropic");
    await res;
    await settle();
    const headers = new Headers(seen[0]!.init.headers);
    expect(headers.get("x-api-key")).toBe("real-key");
    expect(headers.get("authorization")).toBeNull();
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ model: "claude", stream: true });
    expect(costs).toEqual([]);
  });

  it("reports nothing when the provider sends no cost", async () => {
    const { res, costs, settle } = run(Response.json({ usage: { prompt_tokens: 1 } }), { model: "m", messages: [] });
    await res;
    await settle();
    expect(costs).toEqual([]);
  });
});

describe("streamCostScanner", () => {
  it("keeps the last usage cost and ignores other lines", () => {
    const s = streamCostScanner();
    s.push(enc.encode('data: {"usage":{"cost":0.1}}\ndata: not json "usage"\n'));
    s.push(enc.encode('data: {"usage":{"cost":0.3}}'));
    expect(s.cost()).toBe(0.3);
  });
});
