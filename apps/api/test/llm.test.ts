import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ChatRequest, createProvider, type ModelProvider, runLoop, tool } from "../src/llm";

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
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
    const res = createProvider({ FIREWORKS_API_KEY: "fw" }, f.fetchImpl);
    if (!res.ok) throw new Error(res.reason);
    const out = await res.provider.chat(request);

    expect(f.calls[0]!.url).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer fw");
    const body = f.body();
    expect(body.model).toBe("accounts/fireworks/models/kimi-k2p6");
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(body.messages[2].tool_calls[0].function).toEqual({ name: "reply", arguments: '{"text":"x"}' });
    expect(body.tools[0].function.name).toBe("reply");
    expect(out).toEqual({
      text: "",
      toolCalls: [{ id: "t1", name: "reply", input: { text: "ok" } }],
      usage: { inputTokens: 3, outputTokens: 2 },
    });
  });

  it("speaks the Messages API to Anthropic and routes through AI Gateway", async () => {
    const f = recordingFetch({
      content: [
        { type: "text", text: "thinking" },
        { type: "tool_use", id: "tu1", name: "reply", input: { text: "ok" } },
      ],
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
