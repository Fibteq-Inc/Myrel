import type { Message, ProjectSettings } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { agentProject, api, mcp, type Play, signUp, type Turn, until } from "./fake-agent";
import { type FakeRequest, resetFakeModel, setFakeModel } from "./fake-llm";

const call = (name: string, input: unknown) => ({ id: crypto.randomUUID(), name, input });
const isCoordinator = (r: FakeRequest) => r.system.includes("coordinator of a shared project chat");
const FEATURES = ["folders", "cancel", "agent", "models", "coordinator"];
/** Claude Code as the runner lists it, with the models it takes. */
const CLAUDE = { id: "claude", version: "2.1.0", models: [{ id: "opus", name: "Opus", efforts: ["low", "high"] }] };

afterEach(resetFakeModel);

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function idOf(token: string): Promise<string> {
  return ((await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } }).user.id;
}

const patch = (projectId: string, token: string, body: unknown) =>
  api(`/api/projects/${projectId}/settings`, { method: "PATCH", token, body: JSON.stringify(body) });

/** A project whose coordinator works with Claude Code on its owner's computer, played by `play`. */
async function cliProject(play: Play, opts: { features?: string[] } = {}) {
  const token = await signUp();
  const computer = await agentProject(token, play, { features: opts.features ?? FEATURES, hello: { clis: [CLAUDE] } });
  const { project, runnerId } = computer;
  await json(patch(project.id, token, { coordinator: { mode: "cli", runnerId, cli: "claude", model: "opus", effort: "low" } }));
  const ws = (await api(`/api/projects/${project.id}/ws?token=${encodeURIComponent(token)}`, { headers: { upgrade: "websocket" } })).webSocket!;
  ws.accept();
  const agent = await getAgentByName(env.PROJECT_AGENT, project.id);
  const chat = async () => (await agent.getMessagesAfter(0)).messages.filter((m: Message) => m.threadId === null);
  return { ...computer, token, ws, agent, chat };
}

describe("coordinator on a member's CLI", () => {
  it("is turned on only by the computer's owner, on one with the project's folder and the CLI", async () => {
    const owner = await signUp();
    const { project, runnerId } = await agentProject(owner, () => {}, { features: FEATURES, hello: { clis: [CLAUDE] } });
    const settings = async (token: string) => (await json<{ settings: ProjectSettings }>(api(`/api/projects/${project.id}/settings`, { token }))).settings;
    expect((await settings(owner)).coordinator).toEqual({ mode: "model" });

    const on = { mode: "cli", runnerId, cli: "claude", model: "opus", effort: "low" };
    // Codex cannot run without its own tools yet, so it is no choice.
    expect((await patch(project.id, owner, { coordinator: { ...on, cli: "codex" } })).status).toBe(400);
    const saved = await json<{ settings: ProjectSettings }>(patch(project.id, owner, { coordinator: on }));
    expect(saved.settings.coordinator).toEqual({ ...on, computer: "Laptop", by: await idOf(owner) });

    // An admin sees whose computer it is, cannot move it onto that computer as theirs, and can turn it off.
    const admin = await signUp("Ayşe");
    await env.DB.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)")
      .bind(project.id, await idOf(admin), Date.now())
      .run();
    expect((await settings(admin)).coordinator).toMatchObject({ mode: "cli", computer: "Laptop" });
    expect((await patch(project.id, admin, { coordinator: on })).status).toBe(403);
    const off = await json<{ settings: ProjectSettings }>(patch(project.id, admin, { coordinator: { mode: "model" } }));
    expect(off.settings.coordinator).toEqual({ mode: "model" });

    // Not on a computer of theirs without the project's folder, nor with a CLI that computer lacks.
    const other = await agentProject(owner, () => {}, { features: FEATURES });
    expect((await patch(project.id, owner, { coordinator: { ...on, runnerId: other.runnerId } })).status).toBe(400);
    await env.DB.prepare("UPDATE runners SET info = json_set(info, '$.clis', json('[]')) WHERE id = ?").bind(runnerId).run();
    expect((await patch(project.id, owner, { coordinator: on })).status).toBe(400);
  });

  it("works a turn with the CLI, without its tools, and the server's model is not called", async () => {
    let modelCalls = 0;
    setFakeModel((req) => {
      if (isCoordinator(req)) modelCalls++;
      return { text: "", toolCalls: [] };
    });
    const coordinator: Turn[] = [];
    let tools: string[] = [];
    const play: Play = async (turn) => {
      if (!turn.start.coordinator) return;
      coordinator.push(turn);
      const listed = (await (await mcp(turn.start, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: { name: string }[] } };
      tools = listed.result.tools.map((t) => t.name);
      expect((await turn.call("post_message", { text: "Merhaba, buradayım." })).isError).toBe(false);
      return "Done.";
    };
    const { project, ws, chat } = await cliProject(play);
    ws.send(JSON.stringify({ type: "message.send", body: "Selam" }));
    const answer = await until(async () => (await chat()).find((m) => m.authorId === "coordinator"), "the coordinator's answer");

    expect(answer.body).toBe("Merhaba, buradayım.");
    // It ran on the computer, so its line says so; the CLI's subscription pays, so no cost.
    expect(answer.stats).toMatchObject({ runtime: "local", computer: "Laptop", harness: "claude", costMicros: null });
    expect(modelCalls).toBe(0);

    const start = coordinator[0]!.start;
    expect(start.coordinator!.system).toContain("coordinator of a shared project chat");
    expect(start.coordinator!.system).toContain("mcp__myrel__start_thread");
    expect(start.agent).toEqual({ mcpPath: `/api/coordinator-mcp/${project.id}`, token: expect.any(String) });
    expect(start).not.toHaveProperty("github");
    expect(start).not.toHaveProperty("folders");
    expect(start.model).toEqual({ model: "opus", effort: "low" });
    expect(start.prompt).toContain("Selam");
    // Only the coordinator's tools, none of a thread agent's.
    expect(tools).toEqual(expect.arrayContaining(["start_thread", "message_thread", "post_message", "react"]));
    expect(tools).not.toContain("reply");
    expect(tools).not.toContain("update_plan");
    // The turn's token opens nothing once the turn is over.
    await until(async () => (await mcp(start, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status === 401, "the token to close");
    ws.close();
  });

  it("answers with the server's model when the computer's runner cannot run the coordinator", async () => {
    setFakeModel((req) => {
      if (!isCoordinator(req) || req.turns > 1) return { text: "", toolCalls: [] };
      return { text: "", toolCalls: [call("post_message", { text: "Model burada." })] };
    });
    const { ws, frames, chat } = await cliProject(() => {}, { features: ["folders", "cancel", "agent", "models"] });
    ws.send(JSON.stringify({ type: "message.send", body: "Selam" }));
    const answer = await until(async () => (await chat()).find((m) => m.authorId === "coordinator"), "the model's answer");
    expect(answer.body).toBe("Model burada.");
    expect(answer.stats).toMatchObject({ runtime: "cloud" });
    expect(frames.some((f) => f.type === "task.start")).toBe(false);
    ws.close();
  });

  it("answers with the server's model when the CLI fails before it changed anything", async () => {
    setFakeModel((req) => {
      if (!isCoordinator(req) || req.turns > 1) return { text: "", toolCalls: [] };
      return { text: "", toolCalls: [call("post_message", { text: "Model burada." })] };
    });
    const play: Play = (turn) => (turn.start.coordinator ? { fail: "Claude AI usage limit reached" } : undefined);
    const { ws, frames, chat } = await cliProject(play);
    ws.send(JSON.stringify({ type: "message.send", body: "Selam" }));
    const answer = await until(async () => (await chat()).find((m) => m.authorId === "coordinator"), "the model's answer");
    expect(answer.body).toBe("Model burada.");
    expect(frames.filter((f) => f.type === "task.start" && f.coordinator)).toHaveLength(1);
    ws.close();
  });

  it("does not redo a turn the CLI started on: people hear it stopped", async () => {
    let modelCalls = 0;
    setFakeModel((req) => {
      if (isCoordinator(req)) modelCalls++;
      return { text: "", toolCalls: [] };
    });
    const play: Play = async (turn) => {
      if (!turn.start.coordinator) return;
      await turn.call("post_message", { text: "Bakıyorum." });
      return { fail: "Claude AI usage limit reached" };
    };
    const { ws, chat } = await cliProject(play);
    ws.send(JSON.stringify({ type: "message.send", body: "Selam" }));
    const stopped = await until(async () => (await chat()).find((m) => m.authorKind === "system" && m.body.includes("stopped before it finished")), "the note");
    expect(stopped.body).toContain("Claude AI usage limit reached");
    expect((await chat()).filter((m) => m.authorId === "coordinator").map((m) => m.body)).toEqual(["Bakıyorum."]);
    expect(modelCalls).toBe(0);
    ws.close();
  });
});
