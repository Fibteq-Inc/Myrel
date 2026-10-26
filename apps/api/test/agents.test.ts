import { formatPlan, formatPlanUpdate, isPlanMessage, type Message, type Project, type ServerEvent, type Thread, type UsageSummary } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { coordinatorPrompt } from "../src/agents/coordinator";
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
    // People can open the brief under the "on it" line and under the thread's opening line.
    const brief = { kind: "brief", threadId: thread.id, note: "Explain Durable Objects briefly." };
    expect(chat[1]!.relay).toEqual(brief);

    const ctx = (await agent.getThreadContext(thread.id))!;
    expect(ctx.root.body).toBe("Durable Objects'i araştır");
    expect(ctx.messages.map((m) => [m.authorKind, m.authorId, m.body])).toEqual([
      ["agent", "coordinator", "Durable Objects'i araştırıyorum."],
      ["agent", "thread-agent", "Durable Objects'i kısaca açıklayacağım."],
      // One plan card right after the note, updated in place to the plan's last state.
      ["agent", "thread-agent", formatPlan("Durable Objects\n\n✓ Researched\n– Benchmarks")],
      ["agent", "thread-agent", "Durable Objects are single-instance actors with storage."],
    ]);
    expect(ctx.messages[0]!.relay).toEqual(brief);
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

  it("notes plan steps added while the plan card sits further up, one note for changes in a row", async () => {
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      return {
        text: "",
        toolCalls: [
          call("start_thread", { message_id: newMessageId(req.prompt), title: "Fix", instructions: "Fix it.", project_ack: "Tamam." }),
        ],
      };
    });
    const plan = (...steps: [string, string][]) => ({ title: "Fix", steps: steps.map(([text, state]) => ({ text, state })) });
    const play: Play = async (turn) => {
      await turn.call("update_plan", plan(["Read", "active"], ["Fix", "todo"]));
      // The card is still the last message: an added step is in view, no note.
      await turn.call("update_plan", plan(["Read", "active"], ["Fix", "todo"], ["Test", "todo"]));
      await turn.call("reply", { text: "Read the code." });
      // Ticks alone make no note.
      await turn.call("update_plan", plan(["Read", "done"], ["Fix", "active"], ["Test", "todo"]));
      // Now the card is behind the reply: a note, then a second change lands in the same note.
      await turn.call("update_plan", plan(["Read", "done"], ["Fix", "active"], ["Test", "todo"], ["Mobile", "todo"]));
      await turn.call("update_plan", plan(["Read", "done"], ["Fix", "failed"], ["Mobile", "todo"], ["Docs", "todo"]));
      await turn.call("reply", { text: "Fix failed." });
      // After another message, a new note.
      await turn.call("update_plan", plan(["Read", "done"], ["Fix", "failed"], ["Mobile", "todo"], ["Docs", "todo"], ["Retry", "active"]));
      return "Done.";
    };

    const { ws, agent } = await setup(play);
    ws.send(JSON.stringify({ type: "message.send", body: "Fix it" }));
    const thread = await until(async () => {
      const t = (await agent.listThreads())[0];
      return t?.status === "review_ready" ? t : null;
    }, "thread done");

    const ctx = (await agent.getThreadContext(thread.id))!;
    expect(ctx.messages.filter((m) => m.authorId === "thread-agent").map((m) => m.body)).toEqual([
      formatPlan("Fix\n\n✓ Read\n✗ Fix\n○ Mobile\n○ Docs\n✱ Retry"),
      "Read the code.",
      formatPlanUpdate({ added: ["Mobile", "Docs"], removed: ["Test"], failed: ["Fix"] }),
      "Fix failed.",
      formatPlanUpdate({ added: ["Retry"], removed: [], failed: [] }),
    ]);
    // The notes are the plan's bookkeeping, not replies.
    expect(ctx.messages.filter((m) => m.authorId === "thread-agent" && !isPlanMessage(m.body))).toHaveLength(2);
    ws.close();
  });

  it("opens a new plan card under the new ask when a resolved thread gets more work", async () => {
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      const id = newMessageId(req.prompt);
      return id
        ? { text: "", toolCalls: [call("start_thread", { message_id: id, title: "Fix", instructions: "Fix it.", project_ack: "Tamam." })] }
        : { text: "", toolCalls: [] };
    });
    const plan = (...steps: [string, string][]) => ({ title: "Fix", steps: steps.map(([text, state]) => ({ text, state })) });
    const prompts: string[] = [];
    const play: Play = async (turn, index) => {
      prompts.push(turn.prompt);
      if (index === 0) {
        await turn.call("update_plan", plan(["Build", "done"]));
        await turn.call("reply", { text: "Built." });
        await turn.call("resolve_thread");
      } else if (index === 1) {
        // Same title as the finished plan: it still gets a card of its own at the end.
        await turn.call("update_plan", plan(["Tests", "done"]));
        await turn.call("reply", { text: "Tested." });
      } else {
        // The thread was waiting on the person, not resolved: the same round's card grows.
        await turn.call("update_plan", plan(["Tests", "done"], ["Docs", "done"]));
        await turn.call("reply", { text: "Documented." });
      }
    };

    const { ws, agent } = await setup(play);
    ws.send(JSON.stringify({ type: "message.send", body: "Fix it" }));
    const thread: Thread = await until(async () => {
      const t = (await agent.listThreads())[0];
      return t?.resolved ? t : null;
    }, "resolved");
    const agentBodies = async () =>
      (await agent.getThreadContext(thread.id))!.messages.filter((m: Message) => m.authorId === "thread-agent").map((m: Message) => m.body);

    ws.send(JSON.stringify({ type: "message.send", threadId: thread.id, body: "Add tests too" }));
    await until(async () => (await agentBodies()).includes("Tested."), "second round");
    ws.send(JSON.stringify({ type: "message.send", threadId: thread.id, body: "And docs" }));
    await until(async () => (await agentBodies()).includes("Documented."), "third turn");

    expect(await agentBodies()).toEqual([
      formatPlan("Fix\n\n✓ Build"),
      "Built.",
      formatPlan("Fix\n\n✓ Tests\n✓ Docs"),
      "Tested.",
      formatPlanUpdate({ added: ["Docs"], removed: [], failed: [] }),
      "Documented.",
    ]);
    // The reopened turn is told its plan is finished, the next one sees the new round's plan as current.
    expect(prompts[1]).toContain("## Your plan from the earlier round");
    expect(prompts[2]).toContain("## Your current plan, as the thread shows it\nFix\n\n✓ Tests");
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

  it("opens a thread in the cloud when the coordinator says why, even with the person's computer online", async () => {
    setFakeModel((req) => {
      if (!isCoordinator(req)) return { text: "", toolCalls: [] };
      const message_id = newMessageId(req.prompt);
      const input = { message_id, title: "Push", instructions: "Push the branch.", project_ack: "Bulutta başlıyorum.", cloud: true };
      // First without cloud_reason; after the tool error (two more messages), with it.
      if (req.turns === 1) return { text: "", toolCalls: [call("start_thread", input)] };
      if (req.turns === 3) return { text: "", toolCalls: [call("start_thread", { ...input, cloud_reason: "Bu bilgisayarda GitHub kimliği yok." })] };
      return { text: "", toolCalls: [] };
    });
    const { ws, agent, turns } = await setup();
    ws.send(JSON.stringify({ type: "message.send", body: "Bulutta push et" }));

    const thread = await until(async () => (await agent.listThreads())[0] ?? null, "thread");
    expect(thread.runner).toEqual({ id: "cloud", by: "coordinator", reason: "Bu bilgisayarda GitHub kimliği yok." });
    const threadAgent = await getAgentByName(env.THREAD_AGENT, thread.id);
    // The cloud turn fails here: this test runtime has no sandbox. It never reached the computer.
    await until(async () => (await threadAgent.getTasks())[0]?.status === "failed", "cloud turn");
    expect((await threadAgent.getTasks())[0]).toMatchObject({ backend: "sandbox" });
    expect(turns).toHaveLength(0);
    ws.close();
  });

  it("refuses a second thread for the same ask sent again", async () => {
    setFakeModel((req) => {
      if (!isCoordinator(req)) return { text: "", toolCalls: [] };
      if (req.turns === 1) {
        const message_id = newMessageId(req.prompt);
        return {
          text: "",
          toolCalls: [call("start_thread", { message_id, title: "Test PR", instructions: "Open a test PR.", project_ack: "Başlıyorum." })],
        };
      }
      // After the refusal, the coordinator says so instead.
      if (req.turns === 3 && req.prompt.includes("küçük bir test")) {
        return { text: "", toolCalls: [call("post_message", { text: "Zaten o thread'de." })] };
      }
      return { text: "", toolCalls: [] };
    });
    const { ws, agent } = await setup();
    ws.send(JSON.stringify({ type: "message.send", body: "Küçük bir test PR'ı oluşturur musun?" }));
    await until(async () => (await agent.listThreads())[0] ?? null, "first thread");
    ws.send(JSON.stringify({ type: "message.send", body: "küçük bir test PR'ı oluşturur musun" }));
    await until(
      async () => (await agent.getMessagesAfter(0)).messages.find((m) => m.body === "Zaten o thread'de.") ?? null,
      "refusal handled",
    );
    expect(await agent.listThreads()).toHaveLength(1);
    ws.close();
  });

  it("lets the coordinator close a thread it opened by mistake, and reopens it on a reply", async () => {
    setFakeModel((req) => {
      if (!isCoordinator(req)) return { text: "", toolCalls: [] };
      // After close_thread refused, the coordinator leaves it.
      if (req.turns === 3 && req.prompt.includes("Boşver yine")) {
        return { text: "", toolCalls: [call("post_message", { text: "Açık bıraktım." })] };
      }
      if (req.turns > 1) return { text: "", toolCalls: [] };
      const message_id = newMessageId(req.prompt);
      const open = /↳ thread \[(thr_[0-9A-Z]{26})\]/.exec(req.prompt)?.[1];
      if (open && req.prompt.includes("Boşver")) {
        return { text: "", toolCalls: [call("close_thread", { thread_id: open, reason: "cancelled", note: "Bunu kapattım." })] };
      }
      return {
        text: "",
        toolCalls: [call("start_thread", { message_id, title: "X", instructions: "Do X.", project_ack: "Başlıyorum." })],
      };
    });
    const { ws, agent } = await setup();
    ws.send(JSON.stringify({ type: "message.send", body: "X'i yap" }));
    const opened = await until(async () => {
      const t = (await agent.listThreads())[0];
      return t?.status === "review_ready" ? t : null;
    }, "thread");
    ws.send(JSON.stringify({ type: "message.send", body: "Boşver, gerek yok" }));

    const closed = await until(async () => {
      const t = (await agent.getThread(opened.id))!;
      return t.closeReason ? t : null;
    }, "closed");
    expect(closed).toMatchObject({ resolved: true, status: "done", closeReason: "cancelled", duplicateOf: null });
    const all = (await agent.getMessagesAfter(0)).messages;
    expect(all.filter((m) => m.threadId === null).map((m) => m.body)).toContain("Bunu kapattım.");
    expect(all.find((m) => m.threadId === opened.id && m.authorKind === "system")?.body).toBe("Bunu kapattım.");
    expect(await agent.listThreads()).toHaveLength(1);

    // Writing in it opens it again, without the close reason.
    ws.send(JSON.stringify({ type: "message.send", threadId: opened.id, body: "Aslında yap" }));
    const reopened = await until(async () => {
      const t = (await agent.getThread(opened.id))!;
      return t.resolved ? null : t;
    }, "reopened");
    expect(reopened.closeReason).toBeNull();

    // Now that a person wrote in it, only a person may close it.
    ws.send(JSON.stringify({ type: "message.send", body: "Boşver yine" }));
    await until(async () => (await agent.getMessagesAfter(0)).messages.find((m) => m.body === "Açık bıraktım.") ?? null, "refused");
    expect((await agent.getThread(opened.id))!.resolved).toBe(false);
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
    // The coordinator's answer shows in the thread as one line people can open.
    const answer = (await agent.getThreadContext(threadId))!.messages.find((m: Message) => m.relay?.kind === "reply");
    expect(answer).toMatchObject({ authorId: "coordinator", body: "The coordinator answered.", relay: { threadId, note: "Ask the person first." } });
    expect((await agent.getMessagesAfter(0)).messages.filter((m: Message) => m.threadId === null && m.relay?.kind === "reply")).toEqual([]);

    ws.send(JSON.stringify({ type: "message.send", threadId, body: "thanks, all good" }));
    const done = await until(async () => {
      const t = await agent.getThread(threadId);
      return t?.resolved ? t : null;
    }, "resolved");
    expect(done.status).toBe("done");
    expect(await bodies()).toContain("Done.");
    ws.close();
  });

  it("keeps a thread on its person's computer when the coordinator passes it news nobody asked for in the chat", async () => {
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      if (req.prompt.includes("Requests from thread agents")) {
        const asking = /Thread \[(thr_[0-9A-Z]{26})\] asks/.exec(req.prompt)![1];
        // A follow-up (with a line in the project chat), though no person wrote this turn.
        return { text: "", toolCalls: [call("message_thread", { thread_id: asking, note: "The other side agreed.", project_ack: "Passed it on." })] };
      }
      const id = newMessageId(req.prompt);
      return id
        ? { text: "", toolCalls: [call("start_thread", { message_id: id, title: "Contract", instructions: "Agree the contract.", project_ack: "On it." })] }
        : { text: "", toolCalls: [] };
    });
    const play: Play = async (turn, index) => {
      if (index === 0) await turn.call("request_coordinator", { kind: "routing", reason: "Waiting on the other thread." });
      else await turn.call("reply", { text: "Continuing on the computer." });
    };
    const { ws, agent, turns } = await setup(play);
    ws.send(JSON.stringify({ type: "message.send", body: "agree the contract" }));
    const thread: Thread = await until(async () => (await agent.listThreads())[0], "thread");
    const bodies = async () => ((await agent.getThreadContext(thread.id))?.messages ?? []).map((m: Message) => m.body);
    // The forwarded news is worked on the same computer, not in the cloud for nobody.
    await until(async () => (await bodies()).includes("Continuing on the computer."), "the follow-up turn on the computer");
    expect(turns).toHaveLength(2);
    expect(turns[1]!.prompt).toContain("The other side agreed.");
    ws.close();
  });

  it("opens a thread the coordinator starts on another thread's report for the person that thread works for", async () => {
    setFakeModel((req) => {
      if (req.prompt.includes("Requests from thread agents")) {
        // The coordinator posts its own line in the project chat and opens a thread on it.
        if (req.turns === 1) return { text: "", toolCalls: [call("post_message", { text: "CI is red; opening a thread for it." })] };
        const posted = /Posted (cmsg_[0-9A-Z]{26})/.exec(req.last)?.[1];
        return posted
          ? { text: "", toolCalls: [call("start_thread", { message_id: posted, title: "Flaky test", instructions: "Fix the flaky test." })] }
          : { text: "", toolCalls: [] };
      }
      if (req.turns > 1) return { text: "", toolCalls: [] };
      const id = newMessageId(req.prompt);
      return id
        ? { text: "", toolCalls: [call("start_thread", { message_id: id, title: "Paste", instructions: "Build it.", project_ack: "On it." })] }
        : { text: "", toolCalls: [] };
    });
    const play: Play = async (turn) => {
      if (turn.prompt.includes("Build it.")) await turn.call("request_coordinator", { kind: "routing", reason: "Main CI is red from a flaky test." });
    };
    const { ws, agent, token } = await setup(play);
    ws.send(JSON.stringify({ type: "message.send", body: "attach long pastes as files" }));

    const flaky: Thread = await until(async () => (await agent.listThreads()).find((t: Thread) => t.title === "Flaky test"), "thread from the report");
    const me = ((await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } }).user.id;
    const threadAgent = await getAgentByName(env.THREAD_AGENT, flaky.id);
    const meta = (key: string) =>
      runInDurableObject(threadAgent as unknown as DurableObjectStub, (_, state) =>
        state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value || null,
      );
    // Not a thread nobody asked for (which would work in the cloud): it works for whoever the reporting thread did.
    expect(await meta("start_actor")).toBe(me);
    expect(await until(() => meta("requester"), "its first turn")).toBe(me);
    ws.close();
  });

  it("sends a thread agent's choice card to the coordinator first, which answers it or passes it to the person", async () => {
    const questions: string[] = [];
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      if (req.prompt.includes("## Questions from thread agents")) {
        questions.push(req.prompt);
        const id = /Question \[(qst_[0-9A-Z]{26})\]/.exec(req.prompt)![1];
        if (req.prompt.includes("Open a PR?")) {
          return { text: "", toolCalls: [call("answer_question", { question_id: id, answer: "PR aç", source: "proje talimatı" })] };
        }
        if (req.prompt.includes("Which color?")) {
          return { text: "", toolCalls: [call("ask_person", { question_id: id, note: "Renkler için daha önce verilmiş bir karar yok." })] };
        }
        return { text: "", toolCalls: [] }; // leaves it alone
      }
      const id = newMessageId(req.prompt);
      return id
        ? { text: "", toolCalls: [call("start_thread", { message_id: id, title: "Button", instructions: "Fix the button.", project_ack: "On it." })] }
        : { text: "", toolCalls: [] };
    });
    const options = [{ label: "Yes", consequence: "" }, { label: "No", consequence: "" }];
    const answers: string[] = [];
    const play: Play = async (turn, index) => {
      const ask = async (question: string, extra: object = {}) =>
        answers.push((await turn.call("ask_decision", { question, options, recommended: 0, ...extra })).text);
      if (index === 0) await ask("Open a PR?");
      else if (index === 1) {
        expect(turn.prompt).toContain('The coordinator answered your question "Open a PR?"');
        await ask("Which color?");
      } else if (index === 2) await ask("Ship it?");
      else await ask("Delete the branch?", { ask_person: true });
    };

    const { ws, agent, turns } = await setup(play);
    ws.send(JSON.stringify({ type: "message.send", body: "fix the button" }));
    const thread: Thread = await until(async () => (await agent.listThreads())[0], "thread");
    const messages = async () => ((await agent.getThreadContext(thread.id))?.messages ?? []) as Message[];
    const card = (question: string) => async () => (await messages()).find((m) => m.body.includes(`"question": "${question}"`)) ?? null;

    // Answered by the coordinator: a line people can read and open, the agent carries on, and no card.
    const colorCard = await until(card("Which color?"), "the color card passed on");
    const answered = (await messages()).find((m) => m.relay?.kind === "answer");
    expect(answered).toMatchObject({
      authorId: "coordinator",
      body: "Koordinatör ajanın sorusunu cevapladı: **PR aç** (kaynak: proje talimatı)",
      relay: { threadId: thread.id },
    });
    expect(answered!.relay!.note).toContain("Open a PR?");
    expect(await card("Open a PR?")()).toBeNull();
    expect(questions[0]).toContain("Open a PR?\n");
    expect(questions[0]).toContain("1. Yes (recommended)");
    expect(answers[0]).toContain("Sent to the coordinator first");

    // Passed on: the card with the coordinator's line above it, and the thread waits on the person.
    expect(colorCard.authorId).toBe("thread-agent");
    expect(colorCard.body.startsWith("Renkler için daha önce verilmiş bir karar yok.\n\n```decision")).toBe(true);
    await until(async () => ((await agent.getThread(thread.id))?.status === "review_ready" ? true : null), "waiting on the person");

    // Left alone by the coordinator: the card still reaches the person when its turn ends.
    ws.send(JSON.stringify({ type: "message.send", threadId: thread.id, body: "Blue" }));
    const shipCard = await until(card("Ship it?"), "the card the coordinator skipped");
    expect(shipCard.body.startsWith("```decision")).toBe(true);

    // Only the person can answer: straight to them, without the coordinator.
    ws.send(JSON.stringify({ type: "message.send", threadId: thread.id, body: "go" }));
    await until(card("Delete the branch?"), "the card for the person");
    // The card is posted before the tool's answer gets back to the agent.
    await until(() => answers.length === 4 || null, "the agent's answer");
    expect(answers[3]).toContain("The person's choice will arrive");
    expect(questions.some((q) => q.includes("Delete the branch?"))).toBe(false);
    expect(turns).toHaveLength(4);
    ws.close();
  }, 20_000);

  it("keeps a thread waiting on the person after it presented work for their feedback", async () => {
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      const id = newMessageId(req.prompt);
      return id
        ? { text: "", toolCalls: [call("start_thread", { message_id: id, title: "Dark mode", instructions: "Propose it.", project_ack: "On it." })] }
        : { text: "", toolCalls: [] };
    });
    const refusals: string[] = [];
    const play: Play = async (turn) => {
      const latest = turn.prompt.slice(turn.prompt.lastIndexOf("## Thread so far"));
      if (latest.includes("looks good")) {
        await turn.call("resolve_thread");
        return;
      }
      await turn.call("publish_artifact", { title: "Dark mode", html: "<h1>Dark</h1>" });
      await turn.call("reply", { text: "Here is the proposal. What do you think?", needs: "review" });
      refusals.push((await turn.call("resolve_thread")).text);
    };

    const { ws, agent } = await setup(play);
    ws.send(JSON.stringify({ type: "message.send", body: "add dark mode" }));

    const waiting: Thread = await until(async () => {
      const t = (await agent.listThreads())[0];
      return t?.status === "review_ready" ? t : null;
    }, "waiting on the person");
    expect(waiting.resolved).toBe(false);
    expect(refusals[0]).toContain("Not resolved");

    ws.send(JSON.stringify({ type: "message.send", threadId: waiting.id, body: "looks good, thanks" }));
    const done = await until(async () => {
      const t = await agent.getThread(waiting.id);
      return t?.resolved ? t : null;
    }, "resolved");
    expect(done.status).toBe("done");
    ws.close();
  });

  it("forwards a follow-up to a resolved thread, reopens it and links it in the project chat", async () => {
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      const id = newMessageId(req.prompt);
      if (!id) return { text: "", toolCalls: [] };
      const existing = /\[(thr_[0-9A-Z]{26})\] "Calculator"/.exec(req.prompt)?.[1];
      return {
        text: "",
        toolCalls: [
          existing
            ? call("message_thread", { thread_id: existing, note: "Make it orange.", project_ack: "Passed this on." })
            : call("start_thread", { message_id: id, title: "Calculator", instructions: "Build it.", project_ack: "On it." }),
        ],
      };
    });
    const play: Play = async (turn) => {
      if (turn.prompt.includes("Make it orange.")) return;
      await turn.call("reply", { text: "Here it is." });
      await turn.call("resolve_thread");
    };
    const { ws, agent, token } = await setup(play);
    ws.send(JSON.stringify({ type: "message.send", body: "Build a calculator" }));
    const thread: Thread = await until(async () => ((await agent.listThreads())[0]?.resolved ? (await agent.listThreads())[0] : null), "resolved");

    ws.send(JSON.stringify({ type: "message.send", body: "Make the calculator orange" }));
    const forwarded = await until(async () => {
      const chat = (await agent.getMessagesAfter(0)).messages.filter((m: Message) => m.threadId === null);
      return chat.find((m: Message) => m.body.startsWith("Passed this on.")) ?? null;
    }, "forward line");
    expect(forwarded.body).toBe(`Passed this on. [Calculator](#${thread.id})`);
    const followUp = { kind: "follow_up", threadId: thread.id, note: "Make it orange." };
    expect(forwarded.relay).toEqual(followUp);
    const inThread = (await agent.getThreadContext(thread.id))!.messages.at(-1)!;
    expect(inThread).toMatchObject({ authorId: "coordinator", body: "The coordinator forwarded a follow-up.", relay: followUp });
    expect(await agent.getThread(thread.id)).toMatchObject({ resolved: false });
    // The thread is told who asked, from the project chat message itself, not from the model.
    const me = ((await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } }).user.id;
    const threadAgent = await getAgentByName(env.THREAD_AGENT, thread.id);
    const notes = await runInDurableObject(threadAgent as unknown as DurableObjectStub, (_, state) =>
      state.storage.sql.exec<{ forwarded: number; actor: string | null }>("SELECT forwarded, actor FROM notes").toArray(),
    );
    expect(notes).toContainEqual({ forwarded: 1, actor: me });
    ws.close();
  });

  it("passes what one thread delivers on to another open thread it affects", async () => {
    const coordinator: string[] = [];
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      coordinator.push(req.prompt);
      const id = newMessageId(req.prompt);
      if (id) {
        const title = req.prompt.includes(' "MCP" ') ? "Plans" : "MCP";
        return { text: "", toolCalls: [call("start_thread", { message_id: id, title, instructions: title, project_ack: "On it." })] };
      }
      const updates = req.prompt.slice(req.prompt.indexOf("## Thread updates"));
      if (req.prompt.includes("## Thread updates") && updates.includes("MCP connector support is ready")) {
        const thread = (title: string) => new RegExp(`\\[(thr_[0-9A-Z]{26})\\] "${title}"`).exec(req.prompt)![1];
        return {
          text: "",
          toolCalls: [
            call("relay_to_thread", {
              from_thread_id: thread("MCP"),
              to_thread_id: thread("Plans"),
              note: "MCP connectors are a new feature; count them in the plan limits.",
            }),
          ],
        };
      }
      return { text: "", toolCalls: [] };
    });
    const play: Play = async (turn) => {
      const latest = turn.prompt.slice(turn.prompt.lastIndexOf("## Thread so far"));
      if (turn.prompt.includes('Thread: "MCP"')) {
        await turn.call("reply", { text: latest.includes("finish it") ? "MCP connector support is ready." : "Working on MCP." });
      } else if (turn.prompt.includes('From the "MCP" thread: MCP connectors are a new feature')) {
        await turn.call("reply", { text: "Counting MCP connectors in the plan limits too." });
      } else {
        await turn.call("reply", { text: "Drafting the plans." });
      }
    };

    const { ws, agent } = await setup(play);
    const replies = async (threadId: string) =>
      ((await agent.getThreadContext(threadId))?.messages ?? []).filter((m: Message) => m.authorId === "thread-agent").map((m: Message) => m.body);
    const byTitle = async (title: string) => ((await agent.listThreads()) as Thread[]).find((t) => t.title === title) ?? null;

    ws.send(JSON.stringify({ type: "message.send", body: "Add MCP connectors" }));
    const mcpThread = await until(() => byTitle("MCP"), "MCP thread");
    await until(async () => (await replies(mcpThread.id)).includes("Working on MCP.") || null, "MCP reply");
    ws.send(JSON.stringify({ type: "message.send", body: "Set up the membership plans" }));
    const plans = await until(() => byTitle("Plans"), "Plans thread");
    await until(async () => (await replies(plans.id)).includes("Drafting the plans.") || null, "Plans reply");

    // The MCP thread delivers; the coordinator looks at thread updates (normally after a short delay).
    ws.send(JSON.stringify({ type: "message.send", threadId: mcpThread.id, body: "finish it" }));
    await until(async () => (await replies(mcpThread.id)).includes("MCP connector support is ready.") || null, "MCP done");
    await agent.coordinatorTurn();
    await until(
      async () => (await replies(plans.id)).includes("Counting MCP connectors in the plan limits too.") || null,
      "plans thread picks up the relay",
    );
    const marker = (await agent.getThreadContext(plans.id))!.messages.find((m: Message) => m.relay?.kind === "relay");
    expect(marker).toMatchObject({
      body: 'A note came from the "MCP" thread.',
      relay: { threadId: plans.id, fromThreadId: mcpThread.id, note: "MCP connectors are a new feature; count them in the plan limits." },
    });
    const look = coordinator.find((p) => p.includes("MCP connector support is ready."))!;
    expect(look).toContain("Nothing new in the project chat.");
    // Thread updates never land in the project chat.
    const chat = (await agent.getMessagesAfter(0)).messages.filter((m: Message) => m.threadId === null);
    expect(chat.map((m: Message) => m.body)).toEqual(["Add MCP connectors", "On it.", "Set up the membership plans", "On it."]);

    // The Plans thread's answer is not bounced back to the MCP thread.
    await agent.coordinatorTurn();
    expect(coordinator.at(-1)).toContain("Notes already relayed between threads");
    expect(await replies(mcpThread.id)).toEqual(["Working on MCP.", "MCP connector support is ready."]);
    ws.close();
   }, 20_000);

  it("tells a thread waiting on another one when that thread finishes without a word", async () => {
    const coordinator: string[] = [];
    const thread = (prompt: string, title: string) => new RegExp(`\\[(thr_[0-9A-Z]{26})\\] "${title}"`).exec(prompt)![1]!;
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      coordinator.push(req.prompt);
      const id = newMessageId(req.prompt);
      if (id) {
        const title = req.prompt.includes(' "Routines" ') ? "Guide" : "Routines";
        return { text: "", toolCalls: [call("start_thread", { message_id: id, title, instructions: title, project_ack: "On it." })] };
      }
      const finished = req.prompt.indexOf("## Threads that just finished");
      if (finished >= 0) {
        return {
          text: "",
          toolCalls: [
            call("relay_to_thread", {
              from_thread_id: thread(req.prompt, "Routines"),
              to_thread_id: thread(req.prompt, "Guide"),
              note: "Routines is finished; write its section now.",
            }),
          ],
        };
      }
      if (req.prompt.slice(req.prompt.indexOf("## Thread updates")).includes("Waiting for the routines thread.")) {
        const routines = thread(req.prompt, "Routines");
        return {
          text: "",
          toolCalls: [
            call("relay_to_thread", {
              from_thread_id: routines,
              to_thread_id: thread(req.prompt, "Guide"),
              note: `Write the routines section once [Routines](#${routines}) is finished.`,
            }),
          ],
        };
      }
      return { text: "", toolCalls: [] };
    });
    const play: Play = async (turn) => {
      if (turn.prompt.includes('Thread: "Routines"')) await turn.call("reply", { text: "Building routine editing." });
      else if (turn.prompt.includes('From the "Routines" thread: Routines is finished')) await turn.call("reply", { text: "Writing the routines section." });
      else if (turn.prompt.includes('From the "Routines" thread: Write the routines')) await turn.call("reply", { text: "OK, I will wait." });
      else await turn.call("reply", { text: "Waiting for the routines thread." });
    };

    const { ws, agent } = await setup(play);
    const replies = async (threadId: string) =>
      ((await agent.getThreadContext(threadId))?.messages ?? []).filter((m: Message) => m.authorId === "thread-agent").map((m: Message) => m.body);
    const byTitle = async (title: string) => ((await agent.listThreads()) as Thread[]).find((t) => t.title === title) ?? null;

    ws.send(JSON.stringify({ type: "message.send", body: "Let people edit routines" }));
    const routines = await until(() => byTitle("Routines"), "Routines thread");
    await until(async () => (await replies(routines.id)).includes("Building routine editing.") || null, "Routines reply");
    ws.send(JSON.stringify({ type: "message.send", body: "Write the user guide" }));
    const guide = await until(() => byTitle("Guide"), "Guide thread");
    await until(async () => (await replies(guide.id)).includes("Waiting for the routines thread.") || null, "Guide reply");

    // The coordinator tells the guide to wait for the routines thread.
    await agent.coordinatorTurn();
    await until(async () => (await replies(guide.id)).includes("OK, I will wait.") || null, "guide waits");
    await agent.coordinatorTurn();

    // The routines thread finishes with nothing posted the coordinator watches, as when its pull request merges.
    ws.send(JSON.stringify({ type: "thread.resolve", threadId: routines.id, resolved: true }));
    await until(async () => (await agent.getThread(routines.id))?.resolved || null, "routines resolved");
    await agent.coordinatorTurn();
    await until(async () => (await replies(guide.id)).includes("Writing the routines section.") || null, "guide hears it finished");

    const look = coordinator.at(-1)!;
    expect(look).toContain(`- Thread [${routines.id}] "Routines" finished at`);
    expect(look).toContain(`- in [${guide.id}] "Guide"`);
    expect(look).toContain(`Write the routines section once [Routines](#${routines.id}) is finished.`);
    expect(look).toContain("Nothing new in the project chat.");
    // Only open threads hear of it, and only through the coordinator's relay: nothing lands in the project chat.
    const chat = (await agent.getMessagesAfter(0)).messages.filter((m: Message) => m.threadId === null);
    expect(chat).toHaveLength(4);
    ws.close();
  }, 20_000);

  it("does not report a finished thread when no other thread is open", async () => {
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      const id = newMessageId(req.prompt);
      return id
        ? { text: "", toolCalls: [call("start_thread", { message_id: id, title: "Solo", instructions: "Solo", project_ack: "On it." })] }
        : { text: "", toolCalls: [] };
    });
    const { ws, agent } = await setup(async (turn) => {
      await turn.call("reply", { text: "Done." });
    });
    ws.send(JSON.stringify({ type: "message.send", body: "Do one thing" }));
    const solo = await until(async () => (await agent.listThreads())[0] ?? null, "thread");
    await until(async () => ((await agent.getThread(solo.id))?.status === "review_ready" ? true : null), "turn over");
    ws.send(JSON.stringify({ type: "thread.resolve", threadId: solo.id, resolved: true }));
    await until(async () => (await agent.getThread(solo.id))?.resolved || null, "resolved");
    const inbox = await runInDurableObject(agent as unknown as DurableObjectStub, (_, state) =>
      state.storage.sql.exec<{ kind: string }>("SELECT kind FROM coordinator_inbox").toArray(),
    );
    expect(inbox.filter((r) => r.kind === "finished")).toEqual([]);
    ws.close();
  });

  it("keeps working toward a standing goal after the last thread finishes, until it finishes the goal", async () => {
    const prompts: string[] = [];
    setFakeModel((req) => {
      if (!isCoordinator(req)) return { text: "", toolCalls: [] };
      // The next piece of work hangs under the coordinator's own post, started in the same turn.
      const posted = /Posted (cmsg_[0-9A-Z]{26})/.exec(req.last)?.[1];
      if (req.turns > 1) {
        return posted
          ? { text: "", toolCalls: [call("start_thread", { message_id: posted, title: "Part two", instructions: "Part two." })] }
          : { text: "", toolCalls: [] };
      }
      prompts.push(req.prompt);
      const id = newMessageId(req.prompt);
      if (id) {
        return {
          text: "",
          toolCalls: [
            call("set_goal", { message_id: id, goal: "Finish the docs, part one then part two.", line: "Sabaha kadar devam ediyorum." }),
            call("start_thread", { message_id: id, title: "Part one", instructions: "Part one.", project_ack: "Başlıyorum." }),
          ],
        };
      }
      if (req.prompt.includes("No thread is open and the standing goal is still open")) {
        return req.prompt.includes('"Part two"')
          ? { text: "", toolCalls: [call("finish_goal", { summary: "İki bölüm de bitti." })] }
          : { text: "", toolCalls: [call("post_message", { text: "Sırada ikinci bölüm var." })] };
      }
      return { text: "", toolCalls: [] };
    });
    const { ws, agent } = await setup(async (turn) => {
      await turn.call("reply", { text: "Done." });
    });
    const byTitle = async (title: string) => ((await agent.listThreads()) as Thread[]).find((t) => t.title === title) ?? null;
    const finish = async (thread: Thread) => {
      await until(async () => ((await agent.getThread(thread.id))?.status === "review_ready" ? true : null), "turn over");
      ws.send(JSON.stringify({ type: "thread.resolve", threadId: thread.id, resolved: true }));
      await until(async () => (await agent.getThread(thread.id))?.resolved || null, "resolved");
    };

    ws.send(JSON.stringify({ type: "message.send", body: "Dokümanları sabaha kadar devam et, işi bitir" }));
    const one = await until(() => byTitle("Part one"), "first thread");
    const goal = await agent.getGoal();
    expect(goal).toMatchObject({ text: "Finish the docs, part one then part two.", wakes: 0, threads: 1 });
    // Without a time named, it runs until the next 08:00, never more than a day.
    expect(new Date(goal!.until).getUTCHours()).toBe(8);

    // The only thread finishing wakes the coordinator with its full tools, which no plain finished look gets.
    await finish(one);
    await agent.coordinatorTurn();
    expect(prompts.at(-1)).toContain("## Standing goal");
    expect(prompts.at(-1)).toContain("No thread is open and the standing goal is still open");
    expect(prompts.at(-1)).toContain(`- Thread [${one.id}] "Part one" finished at`);
    const chat = async () => (await agent.getMessagesAfter(0)).messages.filter((m: Message) => m.threadId === null);
    expect((await chat()).map((m: Message) => m.body)).toContain("Sırada ikinci bölüm var.");
    const two = await until(() => byTitle("Part two"), "second thread");
    expect(await agent.getGoal()).toMatchObject({ wakes: 1, threads: 2, idle: 0 });

    await finish(two);
    await agent.coordinatorTurn();
    expect(await agent.getGoal()).toBeNull();
    expect((await chat()).map((m: Message) => m.body)).toContain("İki bölüm de bitti.");
    ws.close();
  }, 30_000);

  it("shows the standing goal to clients and lets a member stop it", async () => {
    setFakeModel((req) => {
      if (req.turns > 1 || !isCoordinator(req)) return { text: "", toolCalls: [] };
      const id = newMessageId(req.prompt);
      return id ? { text: "", toolCalls: [call("set_goal", { message_id: id, goal: "Keep going.", line: "Devam ediyorum." })] } : { text: "", toolCalls: [] };
    });
    const { ws, events, agent } = await setup();
    ws.send(JSON.stringify({ type: "message.send", body: "Keep going until morning" }));
    await until(() => events.some((e) => e.type === "goal.updated" && e.goal?.text === "Keep going.") || null, "goal shown");

    ws.send(JSON.stringify({ type: "sync", afterSeq: 0 }));
    const synced = await until(() => events.find((e) => e.type === "sync.result" && e.goal) ?? null, "sync with goal");
    expect(synced).toMatchObject({ goal: { text: "Keep going.", threads: 0 } });

    ws.send(JSON.stringify({ type: "goal.stop" }));
    await until(() => events.some((e) => e.type === "goal.updated" && e.goal === null) || null, "goal stopped");
    expect(await agent.getGoal()).toBeNull();
    const chat = (await agent.getMessagesAfter(0)).messages.filter((m: Message) => m.threadId === null);
    expect(chat.at(-1)!.body).toContain("stopped the standing goal");
    ws.close();
  });

  it("ends a standing goal after wakes that start no work", async () => {
    setFakeModel((req) => {
      if (req.turns > 1 || !isCoordinator(req)) return { text: "", toolCalls: [] };
      const id = newMessageId(req.prompt);
      return id
        ? {
            text: "",
            toolCalls: [
              call("set_goal", { message_id: id, goal: "Keep going.", line: "Devam ediyorum." }),
              call("start_thread", { message_id: id, title: "Solo", instructions: "Solo", project_ack: "On it." }),
            ],
          }
        : { text: "", toolCalls: [] };
    });
    const { ws, agent } = await setup(async (turn) => {
      await turn.call("reply", { text: "Done." });
    });
    ws.send(JSON.stringify({ type: "message.send", body: "Keep going until morning" }));
    const solo = await until(async () => (await agent.listThreads())[0] ?? null, "thread");
    await until(async () => ((await agent.getThread(solo.id))?.status === "review_ready" ? true : null), "turn over");
    ws.send(JSON.stringify({ type: "thread.resolve", threadId: solo.id, resolved: true }));
    await until(async () => (await agent.getThread(solo.id))?.resolved || null, "resolved");

    await agent.coordinatorTurn();
    expect(await agent.getGoal()).toMatchObject({ wakes: 1, idle: 1 });
    // The fallback look finds no open thread and wakes it again; a second idle wake ends the goal.
    const { createdAt } = (await agent.getGoal())!;
    await agent.goalCheck({ createdAt, repeat: true });
    await agent.coordinatorTurn();
    expect(await agent.getGoal()).toBeNull();
    const chat = (await agent.getMessagesAfter(0)).messages.filter((m: Message) => m.threadId === null);
    expect(chat.at(-1)!.body).toContain("The standing goal ended");
    ws.close();
  }, 20_000);

  it("keeps a person's message for the retry when a coordinator turn dies before answering", async () => {
    const prompts: string[] = [];
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      prompts.push(req.prompt);
      const id = newMessageId(req.prompt);
      return id
        ? { text: "", toolCalls: [call("start_thread", { message_id: id, title: "Links", instructions: "Fix it.", project_ack: "On it." })] }
        : { text: "", toolCalls: [] };
    });
    const { ws, agent } = await setup();
    // The first turn dies the way a restart or a failed lookup does: thrown out of the queue callback.
    let failures = 0;
    await runInDurableObject(agent as unknown as DurableObjectStub, (instance) => {
      const self = instance as unknown as { runCoordinatorTurn: (...args: unknown[]) => Promise<void> };
      const real = self.runCoordinatorTurn.bind(instance);
      self.runCoordinatorTurn = async (...args) => {
        if (failures++ === 0) throw new Error("object restarted");
        return real(...args);
      };
    });
    ws.send(JSON.stringify({ type: "message.send", body: "links do not open on mobile" }));

    await until(async () => (failures > 0 ? true : null), "the failed turn");
    await agent.coordinatorTurn();
    const thread = await until(async () => (await agent.listThreads())[0] ?? null, "thread from the retry");
    expect(thread.title).toBe("Links");
    expect(prompts[0]).toMatch(/· NEW\n\s+links do not open on mobile/);
    // Handled once: a later turn finds nothing left.
    await agent.coordinatorTurn();
    expect(prompts).toHaveLength(1);
    ws.close();
  });

  it("lets people edit their own messages; the coordinator marks a project-chat edit seen", async () => {
    const prompts: string[] = [];
    setFakeModel((req) => {
      if (req.turns > 1 || !isCoordinator(req)) return { text: "", toolCalls: [] };
      prompts.push(req.prompt);
      return { text: "", toolCalls: [] }; // says nothing, so Myrel adds the 👀 itself
    });
    const { ws, events, agent } = await setup();
    ws.send(JSON.stringify({ type: "message.send", body: "helo" }));
    const sent = await until(async () => (prompts.length ? (await agent.getMessagesAfter(0)).messages[0] : null), "first turn");

    ws.send(JSON.stringify({ type: "message.edit", messageId: sent.id, body: "hello" }));
    const seen = await until(
      () => events.find((e) => e.type === "reaction.added" && e.reaction.messageId === sent.id) ?? null,
      "seen reaction",
    );
    expect(seen).toMatchObject({ reaction: { emoji: "👀", authorKind: "agent", authorId: "coordinator" } });
    const updated = events.find((e) => e.type === "message.updated" && e.message.id === sent.id);
    expect(updated).toMatchObject({ message: { body: "hello", seq: sent.seq } });
    expect(updated?.type === "message.updated" && updated.message.editedAt).toBeTruthy();
    expect(prompts[1]).toContain("## Messages people edited");
    expect(prompts[1]).toMatch(/· edited [^\n]+\n\s+hello/);

    // Only one's own messages, and not into an empty one.
    ws.send(JSON.stringify({ type: "message.edit", messageId: sent.id, body: "" }));
    await until(() => events.find((e) => e.type === "error" && e.code === "cannot_edit") ?? null, "empty refused");
    const notice = await agent.sendMessage({ threadId: null, authorKind: "agent", authorId: "coordinator", body: "Hi" });
    ws.send(JSON.stringify({ type: "message.edit", messageId: notice.id, body: "Bye" }));
    await until(() => (events.filter((e) => e.type === "error" && e.code === "cannot_edit").length === 2 ? true : null), "agent message refused");
    expect((await agent.getMessage(notice.id))?.body).toBe("Hi");
    ws.close();
  });

  it("shows a thread agent the message a person edited as new, and marks it seen", async () => {
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      const id = newMessageId(req.prompt);
      return id
        ? { text: "", toolCalls: [call("start_thread", { message_id: id, title: "Color", instructions: "Paint it.", project_ack: "On it." })] }
        : { text: "", toolCalls: [] };
    });
    const prompts: string[] = [];
    const play: Play = async (turn) => {
      prompts.push(turn.prompt);
      await turn.call("reply", { text: `Turn ${prompts.length}.` });
    };
    const { ws, events, agent } = await setup(play);
    ws.send(JSON.stringify({ type: "message.send", body: "paint the button" }));
    const thread: Thread = await until(async () => (await agent.listThreads())[0], "thread");
    await until(() => (prompts.length === 1 ? true : null), "first turn");
    await until(async () => ((await agent.getThread(thread.id))?.status === "review_ready" ? true : null), "first turn over");

    ws.send(JSON.stringify({ type: "message.send", threadId: thread.id, body: "make it blue" }));
    await until(() => (prompts.length === 2 ? true : null), "second turn");
    await until(async () => ((await agent.getThread(thread.id))?.status === "review_ready" ? true : null), "second turn over");
    const mine = (await agent.getThreadContext(thread.id))!.messages.find((m: Message) => m.body === "make it blue")!;

    ws.send(JSON.stringify({ type: "message.edit", messageId: mine.id, body: "make it red" }));
    await until(() => (prompts.length === 3 ? true : null), "turn for the edit");
    expect(prompts[2]).toMatch(/· edited [^\n]+· NEW\n\s+make it red/);
    const seen = await until(
      () => events.find((e) => e.type === "reaction.added" && e.reaction.messageId === mine.id) ?? null,
      "seen reaction",
    );
    expect(seen).toMatchObject({ reaction: { emoji: "👀", authorId: "thread-agent" } });
    const bodies = async () => (await agent.getThreadContext(thread.id))!.messages.map((m: Message) => m.body);
    await until(async () => ((await bodies()).includes("Turn 3.") ? true : null), "edit turn reply");
    // The turn lets go of the runner before the socket closes.
    const after = events.indexOf(seen);
    await until(
      () => (events.slice(after).some((e) => e.type === "agent.activity" && e.threadId === thread.id && !e.active) ? true : null),
      "edit turn over",
    );
    ws.close();
  }, 20_000);

  it("names every new project chat message again after the thread updates", () => {
    const m = { id: "cmsg_A", threadId: null, authorKind: "user", authorId: "u1", body: "two asks", createdAt: "2026-10-23T09:30:00.000Z", seq: 1 };
    const prompt = coordinatorPrompt({
      projectName: "P",
      names: { u1: "İsmail" },
      chat: [m as Message],
      threads: [],
      routines: [],
      inbox: [{ kind: "message", messageId: "cmsg_A" }, { kind: "thread", threadId: "thr_B", messageId: "cmsg_C" }],
      knowledge: { instructions: "", memoryIndex: "", memory: [], files: [], moreFiles: 0 },
      now: new Date("2026-10-23T09:30:05Z"),
      defaultTimezone: "UTC",
    });
    expect(prompt.trim().split("\n").at(-1)).toContain("Each NEW project chat message needs its own handling");
    expect(prompt.trim().split("\n").at(-1)).toContain("[cmsg_A]");
  });

  it("puts the time last in the coordinator's prompt, so turns share a prefix for the prompt cache", () => {
    const input = {
      projectName: "P",
      names: {},
      chat: [],
      threads: [],
      routines: [],
      inbox: [],
      knowledge: { instructions: "", memoryIndex: "", memory: [], files: [], moreFiles: 0 },
      defaultTimezone: "UTC",
    };
    const a = coordinatorPrompt({ ...input, now: new Date("2026-10-23T09:30:05Z") });
    const b = coordinatorPrompt({ ...input, now: new Date("2026-10-23T09:41:17Z") });
    const timeAt = a.indexOf("Current time:");
    expect(timeAt).toBeGreaterThan(a.indexOf("## Project chat"));
    expect(b.slice(0, timeAt)).toBe(a.slice(0, timeAt));
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

    // The fake model reports 1000 input / 100 output tokens per call and auto has no built-in price.
    expect(summary.totals).toEqual({
      calls: 2,
      inputTokens: 2000,
      cachedInputTokens: 0,
      outputTokens: 200,
      costMicros: 0,
      unpricedCalls: 2,
    });
    // The thread's agent ran on the person's computer, so no sandbox time.
    expect(summary.sandbox).toEqual({ runs: 0, seconds: 0 });
    await env.DB.prepare(
      "INSERT INTO sandbox_runs (id, project_id, thread_id, started_at, ended_at, seconds) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("task_sandbox_test", project.id, "thread_x", Date.now() - 90_000, Date.now(), 90)
      .run();
    expect((await usage()).sandbox).toEqual({ runs: 1, seconds: 90 });
    expect((await usage("&projectId=proj_01JZZZZZZZZZZZZZZZZZZZZZZZ")).sandbox).toEqual({ runs: 0, seconds: 0 });
    expect(summary.daily).toHaveLength(7);
    expect(summary.daily.at(-1)!.calls).toBe(2);
    expect(summary.byProject).toEqual([expect.objectContaining({ projectId: project.id, name: "Myrel", calls: 2 })]);
    expect(summary.byModel).toEqual([expect.objectContaining({ provider: "fireworks", model: "auto" })]);
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
