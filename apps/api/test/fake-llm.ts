import type { ChatResponse } from "../src/llm";

/** One OpenAI-style chat request as the fake model sees it. last: its newest message, e.g. the previous tool's result. */
export type FakeRequest = { system: string; prompt: string; turns: number; last: string };
export type FakeHandler = (req: FakeRequest) => ChatResponse;

const silent: FakeHandler = () => ({ text: "", toolCalls: [] });
let handler: FakeHandler = silent;

/** Answer model calls with `h` until reset. Tests run serially, so one global handler is enough. */
export function setFakeModel(h: FakeHandler) {
  handler = h;
}

/** The handler answering model calls now. */
export function fakeModel(): FakeHandler {
  return handler;
}

export function resetFakeModel() {
  handler = silent;
  outbound.length = 0;
  emails.length = 0;
  pushStatus.clear();
}

const realFetch = globalThis.fetch;

/** A notification request an agent sent out (email, Web Push, Expo), captured instead of sent. */
export type Outbound = { url: string; headers: Headers; body: Uint8Array };
export const outbound: Outbound[] = [];
const OUTBOUND = ["https://exp.host/", "https://fcm.googleapis.com/"];
/** Status the fake push service answers with, per endpoint. Default 201. */
export const pushStatus = new Map<string, number>();

/** Emails sent through the EMAIL binding (Cloudflare Email Service), captured instead of sent. */
export type SentEmail = { from: string | { name: string; email: string }; to: string; subject: string; text: string; html: string };
export const emails: SentEmail[] = [];

/**
 * Captures sends on the Email Service binding. Bindings share one prototype in
 * the test isolate, so patching it covers the Durable Objects' bindings too.
 */
/** Sign-up's verification emails, kept apart so tests about notifications see only theirs. */
export const verificationEmails: SentEmail[] = [];

export function captureEmail(binding: SendEmail) {
  Object.getPrototypeOf(binding).send = async (message: SentEmail) => {
    (/^(Confirm your email|Set a new password)/.test(String(message.subject)) ? verificationEmails : emails).push(message);
    return { messageId: `test-${emails.length}` };
  };
}

// Durable Objects run in the test isolate, so stubbing fetch here intercepts their model calls.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (OUTBOUND.some((o) => url.startsWith(o))) {
    const body = init?.body;
    const bytes =
      body instanceof Uint8Array ? body : typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array();
    outbound.push({ url, headers: new Headers(init?.headers), body: bytes });
    if (url.startsWith("https://exp.host/")) {
      const messages = JSON.parse(new TextDecoder().decode(bytes)) as { to: string }[];
      return Response.json({
        data: messages.map((m) =>
          m.to.includes("Gone") ? { status: "error", details: { error: "DeviceNotRegistered" } } : { status: "ok" },
        ),
      });
    }
    return new Response(null, { status: pushStatus.get(url) ?? 201 });
  }
  if (!url.startsWith("https://api.fireworks.ai/")) return realFetch(input, init);

  const body = JSON.parse(init!.body as string) as {
    messages: { role: string; content: string | null }[];
  };
  const res = handler({
    system: body.messages[0]!.content ?? "",
    prompt: body.messages[1]!.content ?? "",
    turns: body.messages.length - 1,
    last: body.messages.at(-1)!.content ?? "",
  });
  return Response.json({
    usage: { prompt_tokens: 1000, completion_tokens: 100 },
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
