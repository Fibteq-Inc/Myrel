import { formatPlan, type Message, type Project, type ServerEvent, type Thread, type UsageSummary } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { agentProject, api, type Play, signUp, until } from "./fake-agent";
import { type FakeRequest, resetFakeModel, setFakeModel } from "./fake-llm";

/** A project whose threads are worked by `play`, and a socket listening to it. */
async function setup(play: Play = () => {}) {
  const token = await signUp();
  const computer = await agentProject(token, play);
  const project: Project = computer.project;

  const ws = (await api(`/api/projects/${project.id}/ws?token=${encodeURIComponent(token)}`, {
    headers: { upgrade: "websocket" },
  })).webSocket!;
  const events: ServerEvent[] = [];
  ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string) as ServerEvent));
  ws.accept();
  const agent = await getAgentByName(env.PROJECT_AGENT, project.id);
  return { project, ws, events, agent, token, turns: computer.turns };
}

const call = (name: string, input: unknown) => ({ id: crypto.randomUUID(), name, input });
const isCoordinator = (r: FakeRequest) => r.system.includes("coordinator of a shared project chat");
const newMessageId = (prompt: string) => /\[(cmsg_[0-9A-Z]{26})\][^\n]*· NEW/.exec(prompt)?.[1];

afterEach(resetFakeModel);

describe("coordinator and thread agent", () => {
  it("routes an ask into a thread whose agent answers there", async () => {
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] }; // after its tool results, the model stops
      return {
        text: "",
        toolCalls: [
          call("start_thread", {
            message_id: newMessageId(req.prompt),
            title: "Durable Objects",
            instructions: "Explain Durable Objects briefly.",
            ack: "Durable Objects'i araştırıyorum.",
            project_ack: "Aldım, başlıyorum.",
          }),
        ],
      };
    });
    const play: Play = async (turn) => {
      await turn.call("reply", { text: "Durable Objects'i kısaca açıklayacağım." });
      const steps = (a: string, b: string) => [
        { text: "Researched", state: a },
        { text: "Benchmarks", state: b },
      ];
      await turn.call("update_plan", { title: "Durable Objects", steps: steps("active", "todo") });
      await turn.call("update_plan", { title: "Durable Objects", steps: steps("done", "skipped") });
      await turn.call("reply", { text: "Durable Objects are single-instance actors with storage." });
      return "Answered.";
    };

    const { project, ws, events, agent, turns } = await setup(play);
    ws.send(JSON.stringify({ type: "message.send", body: "Durable Objects'i araştır" }));

    const thread = await until(async () => {
      const t = (await agent.listThreads())[0];
      return t?.status === "review_ready" ? t : null;
    }, "thread reply");
    expect(thread).toMatchObject({ title: "Durable Objects", statusText: "Durable Objects\n\n✓ Researched\n– Benchmarks",
      resolved: false,
    });

    // The project chat reads: the ask, the coordinator's "on it" line, then the thread card under it.
    const chat = (await agent.getMessagesAfter(0)).messages.filter((m) => m.threadId === null);
    expect(chat.map((m) => [m.authorId === "coordinator" ? "coordinator" : "person", m.body])).toEqual([
      ["person", "Durable Objects'i araştır"],
      ["coordinator", "Aldım, başlıyorum."],
    ]);
    expect(thread.ackMessageId).toBe(chat[1]!.id);

    const ctx = (await agent.getThreadContext(thread.id))!;
    expect(ctx.root.body).toBe("Durable Objects'i araştır");
    expect(ctx.messages.map((m) => [m.authorKind, m.authorId, m.body])).toEqual([
      ["agent", "coordinator", "Durable Objects'i araştırıyorum."],
      ["agent", "thread-agent", "Durable Objects'i kısaca açıklayacağım."],
      // One plan card right after the note, updated in place to the plan's last state.
      ["agent", "thread-agent", formatPlan("Durable Objects\n\n✓ Researched\n– Benchmarks")],
      ["agent", "thread-agent", "Durable Objects are single-instance actors with storage."],
    ]);
    const card = ctx.messages[2]!;
    expect(
      events.some((e) => e.type === "message.created" && e.message.id === card.id && e.message.body.includes("✱ Researched")),
    ).toBe(true);
    expect(events.some((e) => e.type === "message.updated" && e.message.id === card.id && e.message.seq === card.seq)).toBe(true);

    // The thread's agent was the person's Claude Code in the project's folder, and saw the brief and the member's name.
    expect(turns).toHaveLength(1);
    expect(turns[0]!.start).toMatchObject({ cli: "claude", folder: "/Users/ismail/code/myrel" });
    expect(turns[0]!.prompt).toContain("You run as Claude Code on the person's own computer");
    expect(turns[0]!.prompt).toContain("Explain Durable Objects briefly.");
    expect(turns[0]!.prompt).toContain("İsmail (member)");
    // It replied itself, so its final message is not posted too.
    expect(ctx.messages.map((m) => m.body)).not.toContain("Answered.");

    // Clients heard about it live.
    await until(() => events.some((e) => e.type === "agent.activity" && e.threadId === thread.id && !e.active), "idle");
    expect(events.some((e) => e.type === "thread.updated" && e.thread.id === thread.id)).toBe(true);
    expect(project.id).toBe(thread.projectId);
    ws.close();
  });

  it("refuses to open a thread on a person's message without an acknowledgement line", async () => {
    setFakeModel((req) => {
      if (!isCoordinator(req)) return { text: "", toolCalls: [] };
      const message_id = newMessageId(req.prompt);
      // First try without project_ack; after the tool error (two more messages), try again with it.
      if (req.turns === 1) return { text: "", toolCalls: [call("start_thread", { message_id, title: "X", instructions: "Do X." })] };
      if (req.turns === 3) {
        return {
          text: "",
          toolCalls: [call("start_thread", { message_id, title: "X", instructions: "Do X.", project_ack: "Tamamdır." })],
        };
      }
      return { text: "", toolCalls: [] };
    });
    const { ws, agent } = await setup();
    ws.send(JSON.stringify({ type: "message.send", body: "X'i yap" }));

    const thread = await until(async () => (await agent.listThreads())[0] ?? null, "thread");
    const ack = (await agent.getMessage(thread.ackMessageId!))!;
    expect(ack).toMatchObject({ threadId: null, authorId: "coordinator", body: "Tamamdır." });
    expect(await agent.listThreads()).toHaveLength(1);
    ws.close();
  });

  it("wakes the thread agent on a reply in the thread, and lets it ask the coordinator", async () => {
    const requests: string[] = [];
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      if (req.prompt.includes("Requests from thread agents")) {
        requests.push(req.prompt);
        const asking = /Thread \[(thr_[0-9A-Z]{26})\] asks/.exec(req.prompt)![1];
        return { text: "", toolCalls: [call("message_thread", { thread_id: asking, note: "Ask the person first." })] };
      }
      const id = newMessageId(req.prompt);
      return id
        ? { text: "", toolCalls: [call("start_thread", { message_id: id, title: "Deploy", instructions: "Deploy it.", project_ack: "On it." })] }
        : { text: "", toolCalls: [] };
    });
    const play: Play = async (turn) => {
      const latest = turn.prompt.slice(turn.prompt.lastIndexOf("## Thread so far"));
      if (latest.includes("thanks")) {
        await turn.call("reply", { text: "Done." });
        await turn.call("resolve_thread");
      } else if (turn.prompt.includes("Ask the person first.")) {
        await turn.call("reply", { text: "Deploy now? Yes / No" });
      } else {
        await turn.call("request_coordinator", { kind: "permission", reason: "Deploying is irreversible." });
      }
    };

    const { ws, agent } = await setup(play);
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

  it("meters every model call and reports it on the usage dashboard", async () => {
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      const id = newMessageId(req.prompt);
      return id
        ? { text: "", toolCalls: [call("start_thread", { message_id: id, title: "Pricing", instructions: "Look into it.", project_ack: "On it." })] }
        : { text: "", toolCalls: [] };
    });

    const { project, ws, token, agent } = await setup(async (turn) => {
      await turn.call("reply", { text: "Here it is." });
    });
    ws.send(JSON.stringify({ type: "message.send", body: "what does it cost?" }));

    const usage = async (query = "") =>
      (await (await api(`/api/usage?days=7&tzOffset=-180${query}`, { token })).json()) as UsageSummary;
    // Coordinator: start_thread, then stop. The thread's agent ran on the person's own CLI and account.
    const summary = await until(async () => {
      const s = await usage();
      return s.totals.calls === 2 ? s : null;
    }, "two metered calls");
    await until(async () => (await agent.getMessagesAfter(0)).messages.some((m: Message) => m.body === "Here it is."), "the reply");

    // The fake model reports 1000 input / 100 output tokens per call and firerouter/opus has no built-in price.
    expect(summary.totals).toEqual({
      calls: 2,
      inputTokens: 2000,
      cachedInputTokens: 0,
      outputTokens: 200,
      costMicros: 0,
      unpricedCalls: 2,
    });
    expect(summary.daily).toHaveLength(7);
    expect(summary.daily.at(-1)!.calls).toBe(2);
    expect(summary.byProject).toEqual([expect.objectContaining({ projectId: project.id, name: "Myrel", calls: 2 })]);
    expect(summary.byModel).toEqual([expect.objectContaining({ provider: "fireworks", model: "firerouter/opus" })]);
    expect(Object.fromEntries(summary.byAgent.map((a) => [a.agent, a.calls]))).toEqual({ coordinator: 2 });

    const [row] = (await env.DB.prepare("SELECT user_id FROM usage_events WHERE project_id = ?").bind(project.id).all())
      .results;
    expect(row!.user_id).toMatch(/.+/);

    // Filters: another project id matches nothing, and other people never see this usage.
    expect((await usage("&projectId=proj_01JZZZZZZZZZZZZZZZZZZZZZZZ")).totals.calls).toBe(0);
    const other = await api("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: `o${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "O" }),
    });
    const theirs = await api("/api/usage", { token: other.headers.get("set-auth-token")! });
    expect(((await theirs.json()) as UsageSummary).totals.calls).toBe(0);
    expect((await api("/api/usage")).status).toBe(401);
    ws.close();
  });
});
