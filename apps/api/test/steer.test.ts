import type { Message, ServerToRunner } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { agentProject, api, type Play, signUp, until } from "./fake-agent";

/** A thread on the person's fake computer, worked by `play`, and a way to write in it as them. */
async function steerSetup(play: Play, runner?: { features: string[]; cli: "codex" }) {
  const token = await signUp();
  const computer = await agentProject(token, play, runner);
  const { project } = computer;
  const me = ((await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } }).user.id;
  const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
  const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: me, body: "Testleri yaz" });
  const thread = await projectAgent.createThread(root.id, "Testler");
  const threadAgent = await getAgentByName(env.THREAD_AGENT, thread.id);
  await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Write the tests." });
  const write = async (body: string, authorId = me) => {
    const m = await projectAgent.sendMessage({ threadId: thread.id, authorKind: "user", authorId, body });
    await threadAgent.wake({ kind: "message", messageId: m.id, body, authorId, seq: m.seq });
    return m;
  };
  const messages = async () => (await projectAgent.getMessagesAfter(0, 500)).messages.filter((m: Message) => m.threadId === thread.id);
  return { ...computer, token, me, projectAgent, threadAgent, thread, write, messages };
}

describe("messages written while the thread's agent works", () => {
  it("reach the running turn with its next call to Myrel, and need no turn of their own", { timeout: 30_000 }, async () => {
    let wrote!: () => void;
    const written = new Promise<void>((r) => (wrote = r));
    // Written once the reply's call returned, so that call cannot take the message in.
    let replied!: () => void;
    const started = new Promise<void>((r) => (replied = r));
    const results: string[] = [];
    const { projectAgent, thread, write, turns, close } = await steerSetup(async (turn, index) => {
      if (index > 0) return;
      await turn.call("reply", { text: "Başlıyorum." });
      replied();
      await written;
      results.push((await turn.call("update_plan", { title: "Testler", steps: [{ text: "Yaz", state: "active" }] })).text);
      results.push((await turn.call("update_plan", { title: "Testler", steps: [{ text: "Yaz", state: "done" }] })).text);
      await turn.call("reply", { text: "Bitti." });
    });

    await started;
    const seenBefore = (await projectAgent.getThread(thread.id))!.seenSeq!;
    const m = await write("Entegrasyon testi de ekle");
    // Clients show it as waiting for the agent until the agent takes it in.
    expect((await projectAgent.getThread(thread.id))!).toMatchObject({ status: "working" });
    expect(m.seq).toBeGreaterThan(seenBefore);
    wrote();

    await until(() => results.length === 2, "the plan calls");
    expect(results[0]).toContain("## A new message in this thread while you work");
    expect(results[0]).toContain("Entegrasyon testi de ekle");
    // Delivered once.
    expect(results[1]).not.toContain("Entegrasyon testi de ekle");
    expect((await projectAgent.getThread(thread.id))!.seenSeq).toBeGreaterThanOrEqual(m.seq);

    await until(async () => (await projectAgent.getThread(thread.id))?.status === "review_ready", "the turn to end");
    // Taken in already: no second turn starts just for it.
    await new Promise((r) => setTimeout(r, 300));
    expect(turns).toHaveLength(1);
    close();
  });

  it("reach the running turn when the person edits one it already took in, marked seen", { timeout: 30_000 }, async () => {
    let wrote!: () => void;
    const written = new Promise<void>((r) => (wrote = r));
    // Written once the reply's call returned, so that call cannot take the message in.
    let replied!: () => void;
    const started = new Promise<void>((r) => (replied = r));
    let edited!: () => void;
    const editing = new Promise<void>((r) => (edited = r));
    const results: string[] = [];
    const { projectAgent, me, thread, write, turns, close } = await steerSetup(async (turn, index) => {
      if (index > 0) return;
      await turn.call("reply", { text: "Başlıyorum." });
      replied();
      await written;
      results.push((await turn.call("update_plan", { title: "Testler", steps: [{ text: "Yaz", state: "active" }] })).text);
      await editing;
      results.push((await turn.call("update_plan", { title: "Testler", steps: [{ text: "Yaz", state: "active" }] })).text);
      results.push((await turn.call("update_plan", { title: "Testler", steps: [{ text: "Yaz", state: "done" }] })).text);
      await turn.call("reply", { text: "Bitti." });
    });

    await started;
    const m = await write("Entegrasyon testi de ekle");
    wrote();
    await until(() => results.length === 1, "the message taken in");
    expect(results[0]).toContain("Entegrasyon testi de ekle");

    // The person changes it while the turn still runs.
    const project = projectAgent as unknown as {
      editOwnMessage(id: string, userId: string, body: string): Promise<string | null>;
      reactionsFor(ids: string[]): Promise<{ emoji: string; authorId: string }[]>;
    };
    expect(await project.editOwnMessage(m.id, me, "Entegrasyon testi de ekle, Vitest ile")).toBeNull();
    edited();

    await until(() => results.length === 3, "the plan calls");
    expect(results[1]).toContain("## A message edited in this thread while you work");
    expect(results[1]).toContain("Entegrasyon testi de ekle, Vitest ile");
    // Delivered once.
    expect(results[2]).not.toContain("Vitest ile");
    const reactions = await until(async () => {
      const r = await project.reactionsFor([m.id]);
      return r.length ? r : null;
    }, "the seen reaction");
    expect(reactions).toMatchObject([{ emoji: "👀", authorId: "thread-agent" }]);

    await until(async () => (await projectAgent.getThread(thread.id))?.status === "review_ready", "the turn to end");
    // Taken in already: no second turn starts just for it.
    await new Promise((r) => setTimeout(r, 300));
    expect(turns).toHaveLength(1);
    close();
  });

  it("wait for their own turn when someone else wrote them", { timeout: 30_000 }, async () => {
    let wrote!: () => void;
    const written = new Promise<void>((r) => (wrote = r));
    const results: string[] = [];
    let checked!: () => void;
    const done = new Promise<void>((r) => (checked = r));
    const { projectAgent, project, thread, write, turns, close } = await steerSetup(async (turn, index) => {
      if (index > 0) return;
      await written;
      results.push((await turn.call("update_plan", { title: "Testler", steps: [{ text: "Yaz", state: "active" }] })).text);
      await done;
    });
    const other = await signUp("Ayşe");
    const otherId = ((await (await api("/api/auth/get-session", { token: other })).json()) as { user: { id: string } }).user.id;
    await env.DB.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
      .bind(project.id, otherId, Date.now())
      .run();
    await until(() => turns.length === 1, "the first turn");
    const m = await write("Ben de bir şey ekleyeyim", otherId);
    wrote();
    await until(() => results.length === 1, "the plan call");
    // Another person's ask may need their own computer or connectors: it waits for a turn that works for them.
    expect(results[0]).not.toContain("Ben de bir şey ekleyeyim");
    expect((await projectAgent.getThread(thread.id))!.seenSeq).toBeLessThan(m.seq);
    checked();
    await until(async () => (await projectAgent.getThread(thread.id))?.status !== "working", "the turns to end");
    close();
  });

  it("go at once when the person interrupts the turn, which continues in a new one", { timeout: 30_000 }, async () => {
    const { project, token, projectAgent, thread, write, turns, frames, send, messages, close } = await steerSetup(async (_turn, index) => {
      // The first turn works until it is stopped.
      if (index === 0) await new Promise(() => {});
    });
    await until(() => turns.length === 1, "the first turn");
    await write("Dur, önce README'yi güncelle");

    const res = await api(`/api/projects/${project.id}/threads/${thread.id}/interrupt`, { method: "POST", token });
    expect(res.status).toBe(200);
    // The runner stops the CLI and says so, as myrel-runner does.
    const cancel = await until(
      () => frames.find((f): f is Extract<ServerToRunner, { type: "task.cancel" }> => f.type === "task.cancel"),
      "the cancel frame",
    );
    expect(cancel.taskId).toBe(turns[0]!.start.taskId);
    send({ type: "task.done", taskId: cancel.taskId, ok: false, cancelled: true, result: "Stopped from Myrel." });

    await until(() => turns.length === 2, "the next turn");
    expect(turns[1]!.prompt).toMatch(/Dur, önce README'yi güncelle/);
    // One line in the thread instead of a report of a cancelled task.
    const bodies = (await messages()).map((m) => m.body);
    expect(bodies).toContain("Stopped; continuing with the new message.");
    expect(bodies.some((b) => b.includes("was cancelled"))).toBe(false);
    await until(async () => (await projectAgent.getThread(thread.id))?.status === "review_ready", "the second turn to end");
    close();
  });

  /** A runner that steers (feature "steer") and answers each "task.steer" with `taken`; the steers it got. */
  async function steeringRunner(taken: boolean, play: Play) {
    const setup = await steerSetup(play, { features: ["folders", "cancel", "agent", "agent-clis", "steer"], cli: "codex" });
    const steers: Extract<ServerToRunner, { type: "task.steer" }>[] = [];
    setup.ws.addEventListener("message", (e) => {
      const frame = JSON.parse(e.data as string) as ServerToRunner;
      if (frame.type !== "task.steer") return;
      steers.push(frame);
      setup.send({ type: "task.steered", requestId: frame.requestId, taken });
    });
    return { ...setup, steers };
  }

  it("go into the running turn at once when its CLI takes them (Codex's app server)", { timeout: 30_000 }, async () => {
    let wrote!: () => void;
    const written = new Promise<void>((r) => (wrote = r));
    // Written once the reply's call returned, so that call cannot take the message in.
    let replied!: () => void;
    const started = new Promise<void>((r) => (replied = r));
    const results: string[] = [];
    const { projectAgent, thread, write, turns, steers, close } = await steeringRunner(true, async (turn, index) => {
      if (index > 0) return;
      await turn.call("reply", { text: "Başlıyorum." });
      replied();
      await written;
      results.push((await turn.call("update_plan", { title: "Testler", steps: [{ text: "Yaz", state: "active" }] })).text);
      await turn.call("reply", { text: "Bitti." });
    });
    await started;
    const m = await write("Entegrasyon testi de ekle");
    const steer = await until(() => steers[0], "the steer frame");
    expect(steer.taskId).toBe(turns[0]!.start.taskId);
    expect(steer.text).toContain("## A new message in this thread while you work");
    expect(steer.text).toContain("Entegrasyon testi de ekle");
    // Delivered as soon as the CLI took it, before any call to Myrel.
    await until(async () => ((await projectAgent.getThread(thread.id))!.seenSeq ?? 0) >= m.seq, "the message marked delivered");
    wrote();
    await until(() => results.length === 1, "the plan call");
    // Not a second time with the next call.
    expect(results[0]).not.toContain("Entegrasyon testi de ekle");
    await until(async () => (await projectAgent.getThread(thread.id))?.status === "review_ready", "the turn to end");
    await new Promise((r) => setTimeout(r, 300));
    expect(turns).toHaveLength(1);
    close();
  });

  it("wait for the next call to Myrel when the running CLI does not take them", { timeout: 30_000 }, async () => {
    let wrote!: () => void;
    const written = new Promise<void>((r) => (wrote = r));
    // Written once the reply's call returned, so that call cannot take the message in.
    let replied!: () => void;
    const started = new Promise<void>((r) => (replied = r));
    const results: string[] = [];
    const { projectAgent, thread, write, steers, close } = await steeringRunner(false, async (turn, index) => {
      if (index > 0) return;
      await turn.call("reply", { text: "Başlıyorum." });
      replied();
      await written;
      results.push((await turn.call("update_plan", { title: "Testler", steps: [{ text: "Yaz", state: "active" }] })).text);
      await turn.call("reply", { text: "Bitti." });
    });
    await started;
    const m = await write("Entegrasyon testi de ekle");
    await until(() => steers.length === 1, "the steer frame");
    // Given back: still waiting for the agent.
    await new Promise((r) => setTimeout(r, 100));
    expect((await projectAgent.getThread(thread.id))!.seenSeq ?? 0).toBeLessThan(m.seq);
    wrote();
    await until(() => results.length === 1, "the plan call");
    expect(results[0]).toContain("Entegrasyon testi de ekle");
    await until(async () => (await projectAgent.getThread(thread.id))?.status === "review_ready", "the turn to end");
    close();
  });
});
