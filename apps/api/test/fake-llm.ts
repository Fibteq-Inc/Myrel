import type { ChatResponse } from "../src/llm";

/** One OpenAI-style chat request as the fake model sees it. */
export type FakeRequest = { system: string; prompt: string; turns: number };
export type FakeHandler = (req: FakeRequest) => ChatResponse;

const silent: FakeHandler = () => ({ text: "", toolCalls: [] });
let handler: FakeHandler = silent;

/** Answer model calls with `h` until reset. Tests run serially, so one global handler is enough. */
export function setFakeModel(h: FakeHandler) {
  handler = h;
}

export function resetFakeModel() {
  handler = silent;
}

const realFetch = globalThis.fetch;

// Durable Objects run in the test isolate, so stubbing fetch here intercepts their model calls.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.fireworks.ai/")) return realFetch(input, init);

  const body = JSON.parse(init!.body as string) as {
    messages: { role: string; content: string | null }[];
  };
  const res = handler({
    system: body.messages[0]!.content ?? "",
    prompt: body.messages[1]!.content ?? "",
    turns: body.messages.length - 1,
  });
  return Response.json({
    choices: [
      {
        message: {
          content: res.text,
          tool_calls: res.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          })),
        },
      },
    ],
  });
}) as typeof fetch;
