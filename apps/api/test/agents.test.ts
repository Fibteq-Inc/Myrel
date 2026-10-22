import { formatPlan, formatPlanUpdate, isPlanMessage, type Message, type Project, type ServerEvent, type Thread, type UsageSummary } from "@myrel/protocol";
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
    const { ws, agent } = await setup(play);
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
