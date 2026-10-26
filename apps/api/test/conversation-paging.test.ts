import { type ConversationPage, type Message, type Project, ServerEvent } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "http://myrel.test";

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function setUp() {
  const signUp = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email: `u${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "T" }),
  });
  const token = signUp.headers.get("set-auth-token")!;
  const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Paging" }) });
  const { project } = (await res.json()) as { project: Project };
  return { token, project, agent: await getAgentByName(env.PROJECT_AGENT, project.id) };
}

describe("conversation paging", () => {
  it("syncs only the project chat's newest messages when asked for recent ones, and says how far it caught up", async () => {
    const { token, project, agent } = await setUp();
    const root = await agent.sendMessage({ threadId: null, authorKind: "user", authorId: "u", body: "start" });
    const thread = await agent.createThread(root.id, "Work");
    for (let i = 0; i < 4; i++) await agent.sendMessage({ threadId: null, authorKind: "user", authorId: "u", body: `chat ${i}` });
    const inThread = await agent.sendMessage({ threadId: thread.id, authorKind: "agent", authorId: "a", body: "working" });

    const res = await api(`/api/projects/${project.id}/ws?token=${encodeURIComponent(token)}`, { headers: { upgrade: "websocket" } });
    const ws = res.webSocket!;
    const result = new Promise<Extract<ServerEvent, { type: "sync.result" }>>((resolve) =>
      ws.addEventListener("message", (e) => {
        const event = ServerEvent.parse(JSON.parse(e.data as string));
        if (event.type === "sync.result") resolve(event);
      }),
    );
    ws.accept();
    ws.send(JSON.stringify({ type: "sync", afterSeq: 0, all: true, recent: 3 }));
    const sync = await result;
    expect(sync.messages.map((m) => m.body)).toEqual(["chat 1", "chat 2", "chat 3"]);
    expect(sync.windows).toEqual([{ threadId: null, hasEarlier: true }]);
    expect(sync.hasMore).toBe(false);
    // The thread's message is newer than the chat's newest: the client is caught up past it anyway.
    expect(sync.lastSeq).toBe(inThread.seq);
    expect(sync.threads.map((t) => t.id)).toEqual([thread.id]);
    ws.close();
  });

  it("pages a thread from its newest message back, with the message it opened from on its oldest page", async () => {
    const { token, project, agent } = await setUp();
    const root = await agent.sendMessage({ threadId: null, authorKind: "user", authorId: "u", body: "start" });
    const thread = await agent.createThread(root.id, "Work");
    const sent: Message[] = [];
    for (let i = 0; i < 5; i++) sent.push(await agent.sendMessage({ threadId: thread.id, authorKind: "agent", authorId: "a", body: `t${i}` }));

    const newest = await agent.getConversationPage(thread.id, null, 3);
    expect(newest.messages.map((m) => m.body)).toEqual(["t2", "t3", "t4"]);
    expect(newest.hasEarlier).toBe(true);
    expect(newest.root).toBeUndefined();

    const page = (await (
      await api(`/api/projects/${project.id}/messages?conversation=${thread.id}&before=${sent[2]!.seq}&limit=3`, { token })
    ).json()) as ConversationPage;
    expect(page.messages.map((m) => m.body)).toEqual(["t0", "t1"]);
    expect(page.hasEarlier).toBe(false);
    expect(page.root?.id).toBe(root.id);

    const chat = (await (await api(`/api/projects/${project.id}/messages?conversation=chat`, { token })).json()) as ConversationPage;
    expect(chat.messages.map((m) => m.id)).toEqual([root.id]);
    expect((await api(`/api/projects/${project.id}/messages?conversation=nope`, { token })).status).toBe(400);
  });

  it("hands a thread's replies with stats to its usage tab", async () => {
    const { token, project, agent } = await setUp();
    const root = await agent.sendMessage({ threadId: null, authorKind: "user", authorId: "u", body: "start" });
    const thread = await agent.createThread(root.id, "Work");
    await agent.sendMessage({ threadId: thread.id, authorKind: "user", authorId: "u", body: "no stats" });
    const stats = { model: "m", durationMs: 1, calls: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costMicros: 1, runtime: "cloud" as const };
    const counted = await agent.sendMessage({ threadId: thread.id, authorKind: "agent", authorId: "a", body: "done", stats });
    const res = await api(`/api/projects/${project.id}/threads/${thread.id}/usage`, { token });
    const { messages } = (await res.json()) as { messages: Message[] };
    expect(messages.map((m) => m.id)).toEqual([counted.id]);
  });
});
