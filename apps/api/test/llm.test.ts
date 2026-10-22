import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type CallRecord,
  type ChatRequest,
  costMicros,
  createProvider,
  DEFAULT_PRICES,
  metered,
  type ModelProvider,
  parsePrices,
  priceFor,
  readsImages,
  runLoop,
  taskModel,
  tool,
} from "../src/llm";

function recordingFetch(response: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(response);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, body: (i = 0) => JSON.parse(calls[i]!.init.body as string) };
}

const request: ChatRequest = {
  system: "sys",
  tools: [{ name: "reply", description: "d", parameters: { type: "object" } }],
  turns: [
    { role: "user", content: "hi" },
    { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "reply", input: { text: "x" } }] },
    { role: "tool", results: [{ id: "c1", name: "reply", output: "Sent." }] },
  ],
};

describe("createProvider", () => {
  it("defaults to Fireworks and explains a missing key", () => {
    const res = createProvider({});
    expect(res).toEqual({ ok: false, reason: expect.stringContaining("FIREWORKS_API_KEY") });
  });

  it("rejects unknown providers", () => {
    expect(createProvider({ LLM_PROVIDER: "nope" }).ok).toBe(false);
  });

  it("speaks the OpenAI wire format to Fireworks", async () => {
    const f = recordingFetch({
      choices: [{ message: { content: "", tool_calls: [{ id: "t1", function: { name: "reply", arguments: '{"text":"ok"}' } }] } }],
      model: "accounts/fireworks/models/kimi-k2p6",
      usage: { prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } },
    });
    const res = createProvider({ FIREWORKS_API_KEY: "fw" }, f.fetchImpl);
    if (!res.ok) throw new Error(res.reason);
    const out = await res.provider.chat(request);

    expect(f.calls[0]!.url).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer fw");
    const body = f.body();
    expect(body.model).toBe("firerouter/opus");
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(body.messages[2].tool_calls[0].function).toEqual({ name: "reply", arguments: '{"text":"x"}' });
    expect(body.tools[0].function.name).toBe("reply");
    expect(out).toEqual({
      text: "",
      toolCalls: [{ id: "t1", name: "reply", input: { text: "ok" } }],
      usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1 },
      model: "accounts/fireworks/models/kimi-k2p6",
    });
  });

  it("takes the call's cost from the response when the provider sends one", async () => {
    const reply = { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
    const inUsage = recordingFetch({ ...reply, usage: { ...reply.usage, cost: 0.0042 } });
    const p1 = createProvider({ FIREWORKS_API_KEY: "fw" }, inUsage.fetchImpl);
    if (!p1.ok) throw new Error(p1.reason);
    expect((await p1.provider.chat(request)).costUsd).toBe(0.0042);

    const inHeader: typeof fetch = async () =>
      new Response(JSON.stringify(reply), { headers: { "content-type": "application/json", "x-litellm-response-cost": "1.175e-05", "x-litellm-key-spend": "9" } });
    const p2 = createProvider({ FIREWORKS_API_KEY: "fw" }, inHeader);
    if (!p2.ok) throw new Error(p2.reason);
    expect((await p2.provider.chat(request)).costUsd).toBe(0.00001175);
  });

  it("speaks the Messages API to Anthropic and routes through AI Gateway", async () => {
    const f = recordingFetch({
      content: [
        { type: "text", text: "thinking" },
        { type: "tool_use", id: "tu1", name: "reply", input: { text: "ok" } },
      ],
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 },
    });
    const res = createProvider(
      {
        LLM_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "ak",
        AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acc/gw/",
        AI_GATEWAY_TOKEN: "gt",
      },
      f.fetchImpl,
    );
    if (!res.ok) throw new Error(res.reason);
    const out = await res.provider.chat(request);

    expect(f.calls[0]!.url).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic/v1/messages");
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("ak");
    expect(headers["cf-aig-authorization"]).toBe("Bearer gt");
    const body = f.body();
    expect(body.system).toBe("sys");
    expect(body.messages[1].content[0]).toMatchObject({ type: "tool_use", id: "c1" });
    expect(body.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "Sent." }] });
    expect(out.text).toBe("thinking");
    expect(out.toolCalls).toEqual([{ id: "tu1", name: "reply", input: { text: "ok" } }]);
    // Cache reads and writes are folded into the input count.
    expect(out.usage).toEqual({ inputTokens: 45, outputTokens: 4, cachedInputTokens: 30 });
  });
});

function scripted(responses: Awaited<ReturnType<ModelProvider["chat"]>>[]): ModelProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    id: "fake",
    model: "fake",
    requests,
    async chat(req) {
      requests.push(structuredClone(req));
      return responses.shift() ?? { text: "", toolCalls: [] };
    },
  };
}

describe("runLoop", () => {
  it("runs tools, feeds results and errors back, and stops when the model does", async () => {
    const said: string[] = [];
    const provider = scripted([
      {
        text: "",
        toolCalls: [
          { id: "a", name: "say", input: { text: "hello" } },
          { id: "b", name: "say", input: { wrong: 1 } },
          { id: "c", name: "missing", input: {} },
        ],
      },
      { text: "done", toolCalls: [] },
    ]);
    const result = await runLoop({
      provider,
      system: "s",
      prompt: "p",
      tools: [
        tool({
          name: "say",
          description: "say",
          input: z.object({ text: z.string() }),
          run: ({ text }) => {
            said.push(text);
            return "ok";
          },
        }),
      ],
    });

    expect(said).toEqual(["hello"]);
    expect(result).toMatchObject({ steps: 2, finalText: "done", stopped: "done" });
    expect(provider.requests[0]!.tools[0]!.parameters).toMatchObject({ type: "object", required: ["text"] });
    const toolTurn = provider.requests[1]!.turns[2]!;
    expect(toolTurn.role === "tool" && toolTurn.results.map((r) => [r.output.slice(0, 13), !!r.isError])).toEqual([
      ["ok", false],
      ["Invalid input", true],
      ["Unknown tool ", true],
    ]);
  });

  it("stops after a tool asks to, and at maxSteps", async () => {
    const loopTool = (stop: boolean) =>
      tool({ name: "t", description: "t", input: z.object({}), run: () => ({ output: "x", stop }) });
    const call = { text: "", toolCalls: [{ id: "1", name: "t", input: {} }] };

    const stopped = await runLoop({ provider: scripted([call, call]), system: "", prompt: "", tools: [loopTool(true)] });
    expect(stopped).toMatchObject({ steps: 1, stopped: "tool_stop" });

    const capped = await runLoop({
      provider: scripted([call, call, call]),
      system: "",
      prompt: "",
      tools: [loopTool(false)],
      maxSteps: 2,
    });
    expect(capped).toMatchObject({ steps: 2, stopped: "max_steps" });
  });
});

describe("pricing", () => {
  it("finds prices by exact id, bare id and longest prefix", () => {
    const prices = { ...DEFAULT_PRICES, "kimi-k2p6": { input: 0.6, output: 2.5 } };
    expect(priceFor("claude-opus-5-5", prices)).toEqual(DEFAULT_PRICES["claude-opus-5-5"]);
    expect(priceFor("accounts/fireworks/models/kimi-k2p6", prices)).toEqual({ input: 0.6, output: 2.5 });
    expect(priceFor("claude-sonnet-5-5-20261001", prices)).toEqual(DEFAULT_PRICES["claude-sonnet-5-5"]);
    expect(priceFor("firerouter/opus", prices)).toBeNull();
  });

  it("charges cached input at the cache rate, in micro-dollars", () => {
    // 1M uncached input at $4 + 1M cached at $0.20 + 0.5M output at $20 = $14.20
    const usage = { inputTokens: 2_000_000, cachedInputTokens: 1_000_000, outputTokens: 500_000 };
    expect(costMicros(usage, { input: 4, output: 20, cachedInput: 0.2 })).toBe(14_200_000);
    expect(costMicros({ inputTokens: 1000, outputTokens: 0 }, { input: 1, output: 1 })).toBe(1000);
  });

  it("reads LLM_PRICES and ignores malformed entries", () => {
    expect(parsePrices('{"a": {"input": 1, "output": 2}, "b": {"input": "x"}}')).toEqual({
      a: { input: 1, output: 2, cachedInput: undefined },
    });
    expect(parsePrices("not json")).toEqual({});
  });
});

describe("metered", () => {
  it("reports each call and never fails the call when recording does", async () => {
    const seen: CallRecord[] = [];
    const inner = scripted([
      { text: "a", toolCalls: [], usage: { inputTokens: 5, outputTokens: 1 }, model: "routed-model" },
      { text: "b", toolCalls: [] },
    ]);
    const provider = metered(inner, (call) => {
      seen.push(call);
      if (seen.length === 2) throw new Error("db down");
    });
    expect((await provider.chat(request)).text).toBe("a");
    expect((await provider.chat(request)).text).toBe("b");
    expect(seen.map((c) => [c.servedModel, c.usage.inputTokens])).toEqual([
      ["routed-model", 5],
      [null, 0],
    ]);
  });
});

describe("callCostMicros", () => {
  it("prefers the provider's own figure over the price table", async () => {
    const { callCostMicros } = await import("../src/usage");
    const call = { provider: "fireworks", model: "firerouter/opus", servedModel: "glm-5p3", usage: { inputTokens: 1000, outputTokens: 100 }, latencyMs: 1 };
    expect(callCostMicros({ ...call, costUsd: 0.0123 }, DEFAULT_PRICES)).toBe(12_300);
    expect(callCostMicros({ ...call, servedModel: "unlisted-model" }, DEFAULT_PRICES)).toBeNull();
    expect(callCostMicros(call, { "glm-5p3": { input: 1, output: 2 } })).toBe(1200);
  });

  it("prices a FireRouter call by the open model that served it", async () => {
    const { callCostMicros } = await import("../src/usage");
    const call = { provider: "fireworks", model: "firerouter/opus", servedModel: "glm-5p3-flash", usage: { inputTokens: 11_400, outputTokens: 644 }, latencyMs: 1 };
    // 11,400 input at $0.15/M + 644 output at $0.50/M
    expect(callCostMicros(call, DEFAULT_PRICES)).toBe(2032);
    expect(priceFor("glm-5p3-flash", DEFAULT_PRICES)).toEqual(DEFAULT_PRICES["glm-5p3-flash"]);
  });
});

describe("TurnMeter", () => {
  it("sums calls between messages and marks the total unknown when a call is unpriced", async () => {
    const { TurnMeter } = await import("../src/usage");
    const meter = new TurnMeter("configured");
    const call = (servedModel: string | null, input: number) => ({
      provider: "fireworks",
      model: "firerouter/opus",
      servedModel,
      usage: { inputTokens: input, outputTokens: 10, cachedInputTokens: 2 },
      latencyMs: 5,
    });
    expect(meter.take()).toBeNull();
    meter.add(call("claude-opus-5-5", 100), 500);
    meter.add(call("kimi-k2p6", 50), 20);
    expect(meter.take()).toMatchObject({
      model: "kimi-k2p6",
      calls: 2,
      inputTokens: 150,
      cachedInputTokens: 4,
      outputTokens: 20,
      costMicros: 520,
      runtime: "cloud",
    });
    // Counting starts afresh after each message.
    meter.add(call(null, 10), null);
    expect(meter.take()).toMatchObject({ model: "firerouter/opus", calls: 1, costMicros: null });
    const task = {
      title: "Fix",
      harness: "claude",
      runtime: "local" as const,
      model: null,
      durationMs: 1000,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: null,
    };
    // With no new calls, the turn's last model still names who wrote it.
    expect(meter.take(task)).toMatchObject({ model: "firerouter/opus", calls: 0, runtime: "local", task });
  });
});

describe("readsImages", () => {
  it("guesses from the model's name, never trusting a router", () => {
    expect(readsImages("anthropic", "claude-sonnet-4-5")).toBe(true);
    expect(readsImages("openai", "gpt-4o-mini")).toBe(true);
    expect(readsImages("openai", "accounts/fireworks/models/qwen2p5-vl-32b-instruct")).toBe(true);
    expect(readsImages("openai", "accounts/fireworks/models/kimi-k2p6")).toBe(true);
    expect(readsImages("openai", "accounts/fireworks/models/glm-5p3")).toBe(false);
    expect(readsImages("openai", "firerouter/opus")).toBe(false);
  });

  it("lets RUNNER_IMAGES decide for the harness's model", () => {
    const env = { LLM_PROVIDER: "fireworks", LLM_MODEL: "firerouter/opus", FIREWORKS_API_KEY: "k" };
    const pick = (RUNNER_IMAGES: string) => {
      const r = taskModel({ ...env, RUNNER_IMAGES } as never);
      return r.ok ? r.model.images : null;
    };
    expect(pick("")).toBe(false);
    expect(pick("true")).toBe(true);
  });
});
