import { afterEach, describe, expect, it, vi } from "vitest";
import { modelCallAllowed, type Price, proxyModel, streamCostScanner } from "../src/llm";

afterEach(() => vi.unstubAllGlobals());

const enc = new TextEncoder();

function run(upstream: Response, body: object, kind: "openai" | "anthropic" = "openai", prices?: Record<string, Price>) {
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
  const res = proxyModel(req, { url: "https://up.test/v1/chat/completions", apiKey: "real-key", kind, prices }, async (usd) => void costs.push(usd), (p) => void waits.push(p));
  return { res, seen, costs, settle: () => Promise.all(waits) };
}

describe("modelCallAllowed", () => {
  it("lets through inference calls only", () => {
    expect(modelCallAllowed("openai", "POST", "chat/completions")).toBe(true);
    expect(modelCallAllowed("anthropic", "POST", "v1/messages")).toBe(true);
    expect(modelCallAllowed("openai", "GET", "chat/completions")).toBe(false);
    expect(modelCallAllowed("openai", "POST", "files")).toBe(false);
    expect(modelCallAllowed("openai", "DELETE", "files/file-1")).toBe(false);
    expect(modelCallAllowed("openai", "POST", "chat/completions/../../files")).toBe(false);
    expect(modelCallAllowed("anthropic", "POST", "v1/files")).toBe(false);
  });
});

describe("proxyModel", () => {
  it("refuses an OpenAI-compatible call for another model without calling the provider", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return Response.json({});
    });
    const req = new Request("https://myrel.test/api/agent-mcp/t/model/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "accounts/fireworks/models/very-expensive", messages: [] }),
    });
    const out = await proxyModel(req, { url: "https://up.test/v1/chat/completions", apiKey: "k", kind: "openai", model: "firerouter/opus" }, async () => {}, () => {});
    expect(out.status).toBe(403);
    expect(seen).toEqual([]);
  });

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

  it("prices a JSON call by the model its response names when the provider sends no cost", async () => {
    const prices = { "glm-5p3-flash": { input: 0.15, output: 0.5, cachedInput: 0.03 } };
    const upstream = Response.json({ model: "glm-5p3-flash", usage: { prompt_tokens: 11_400, completion_tokens: 644 } });
    const { res, costs, settle } = run(upstream, { model: "auto", messages: [] }, "openai", prices);
    await res;
    await settle();
    // 11,400 input at $0.15/M + 644 output at $0.50/M
    expect(costs).toEqual([0.002032]);
  });

  it("prices a stream by the model its chunks name and its usage chunk", async () => {
    const prices = { "kimi-k3": { input: 3, output: 15, cachedInput: 0.3 } };
    const sse =
      'data: {"model":"kimi-k3","choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"model":"kimi-k3","choices":[],"usage":{"prompt_tokens":2000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":1000}}}\n\ndata: [DONE]\n\n';
    const upstream = new Response(sse, { headers: { "content-type": "text/event-stream" } });
    const { res, costs, settle } = run(upstream, { model: "auto", stream: true, messages: [] }, "openai", prices);
    await (await res).text();
    await settle();
    // 1,000 uncached at $3/M + 1,000 cached at $0.30/M + 100 output at $15/M
    expect(costs).toEqual([0.0048]);
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
