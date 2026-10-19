import type { Message, Project, ServerEvent, Thread } from "@altair/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeRequest, resetFakeModel, setFakeModel } from "./fake-llm";

const BASE = "http://altair.test";

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function setup() {
  const email = `u${crypto.randomUUID()}@example.com`;
  const signUp = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "İsmail" }),
  });
  const token = signUp.headers.get("set-auth-token")!;
  const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Altair" }) });
  const { project } = (await res.json()) as { project: Project };

  const ws = (await api(`/api/projects/${project.id}/ws?token=${encodeURIComponent(token)}`, {
    headers: { upgrade: "websocket" },
  })).webSocket!;
  const events: ServerEvent[] = [];
  ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string) as ServerEvent));
  ws.accept();
  const agent = await getAgentByName(env.PROJECT_AGENT, project.id);
  return { project, ws, events, agent };
}

async function until<T>(fn: () => T | Promise<T>, what: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 160; i++) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const call = (name: string, input: unknown) => ({ id: crypto.randomUUID(), name, input });
const isCoordinator = (r: FakeRequest) => r.system.includes("coordinator of a shared project chat");
const newMessageId = (prompt: string) => /\[(cmsg_[0-9A-Z]{26})\][^\n]*· NEW/.exec(prompt)?.[1];

afterEach(resetFakeModel);

describe("coordinator and thread agent", () => {
  it("routes an ask into a thread whose agent answers there", async () => {
    const seen: FakeRequest[] = [];
    setFakeModel((req) => {
      seen.push(req);
      if (req.turns > 1) return { text: "", toolCalls: [] }; // after its tool results, the model stops
      if (isCoordinator(req)) {
        return {
          text: "",
          toolCalls: [
            call("start_thread", {
              message_id: newMessageId(req.prompt),
              title: "Durable Objects",
              instructions: "Explain Durable Objects briefly.",
              ack: "Durable Objects'i araştırıyorum.",
            }),
          ],
        };
      }
      return {
        text: "",
        toolCalls: [
          call("update_status", { text: "Durable Objects\n\n✓ Researched" }),
          call("reply", { text: "Durable Objects are single-instance actors with storage." }),
        ],
      };
    });

    const { project, ws, events, agent } = await setup();
    ws.send(JSON.stringify({ type: "message.send", body: "Durable Objects'i araştır" }));

    const thread = await until(async () => {
      const t = (await agent.listThreads())[0];
      return t?.status === "review_ready" ? t : null;
    }, "thread reply");
    expect(thread).toMatchObject({ title: "Durable Objects", statusText: "Durable Objects\n\n✓ Researched", resolved: false });

    const ctx = (await agent.getThreadContext(thread.id))!;
    expect(ctx.root.body).toBe("Durable Objects'i araştır");
    expect(ctx.messages.map((m) => [m.authorKind, m.authorId, m.body])).toEqual([
      ["agent", "coordinator", "Durable Objects'i araştırıyorum."],
      ["agent", "thread-agent", "Durable Objects are single-instance actors with storage."],
    ]);

    // The thread agent saw the brief and the member's name.
    const threadReq = seen.find((r) => !isCoordinator(r))!;
    expect(threadReq.prompt).toContain("Explain Durable Objects briefly.");
    expect(threadReq.prompt).toContain("İsmail (member)");

    // Clients heard about it live.
    await until(() => events.some((e) => e.type === "agent.activity" && e.threadId === thread.id && !e.active), "idle");
    expect(events.some((e) => e.type === "thread.updated" && e.thread.id === thread.id)).toBe(true);
    expect(project.id).toBe(thread.projectId);
    ws.close();
  });

  it("wakes the thread agent on a reply in the thread, and lets it ask the coordinator", async () => {
    const requests: string[] = [];
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      if (isCoordinator(req)) {
        if (req.prompt.includes("Requests from thread agents")) {
          requests.push(req.prompt);
          const asking = /Thread \[(thr_[0-9A-Z]{26})\] asks/.exec(req.prompt)![1];
          return { text: "", toolCalls: [call("message_thread", { thread_id: asking, note: "Ask the person first." })] };
        }
        const id = newMessageId(req.prompt);
        return id
          ? { text: "", toolCalls: [call("start_thread", { message_id: id, title: "Deploy", instructions: "Deploy it." })] }
          : { text: "", toolCalls: [] };
      }
      if (req.prompt.includes("thanks")) {
        return { text: "", toolCalls: [call("reply", { text: "Done." }), call("resolve_thread", {})] };
      }
      if (req.prompt.includes("Ask the person first.")) {
        return { text: "", toolCalls: [call("reply", { text: "Deploy now? Yes / No" })] };
      }
      return { text: "", toolCalls: [call("request_coordinator", { kind: "permission", reason: "Deploying is irreversible." })] };
    });

    const { ws, agent } = await setup();
    ws.send(JSON.stringify({ type: "message.send", body: "deploy the site" }));

    const thread: Thread = await until(async () => (await agent.listThreads())[0], "thread");
    const threadId = thread.id;
    const bodies = async () => ((await agent.getThreadContext(threadId))?.messages ?? []).map((m: Message) => m.body);
    await until(async () => (await bodies()).includes("Deploy now? Yes / No"), "question after coordinator note");
    expect(requests[0]).toContain("asks (permission): Deploying is irreversible.");

    ws.send(JSON.stringify({ type: "message.send", threadId, body: "thanks, all good" }));
    const done = await until(async () => {
      const t = await agent.getThread(threadId);
      return t?.resolved ? t : null;
    }, "resolved");
    expect(done.status).toBe("done");
    expect(await bodies()).toContain("Done.");
    ws.close();
  });

  it("reports a failed coordinator turn in the project chat", async () => {
    setFakeModel(() => {
      throw new Error("should not be called");
    });
    const { ws, agent } = await setup();
    // A thread that does not exist is refused without reaching any agent.
    ws.send(JSON.stringify({ type: "message.send", threadId: "thr_01JZZZZZZZZZZZZZZZZZZZZZZZ", body: "x" }));
    ws.send(JSON.stringify({ type: "message.send", body: "hello" }));
    const notice = await until(async () => {
      const { messages } = await agent.getMessagesAfter(0);
      return messages.find((m: Message) => m.authorKind === "system");
    }, "system notice");
    // The fake model throws, so the coordinator reports the failure instead of going silent.
    expect(notice.body).toContain("should not be called");
    ws.close();
  });
});
