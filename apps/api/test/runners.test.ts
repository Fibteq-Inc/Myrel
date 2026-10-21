import type { Project, ProjectWorkspace, Runner, ServerToRunner } from "@myrel/protocol";
import { RUNNER_PROTOCOL_VERSION } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { resetFakeModel } from "./fake-llm";

const BASE = "http://myrel.test";

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function signUp() {
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email: `u${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "İsmail" }),
  });
  return res.headers.get("set-auth-token")!;
}

async function createProject(token: string): Promise<Project> {
  const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Myrel" }) });
  return ((await res.json()) as { project: Project }).project;
}

async function pair(user: string) {
  const codeRes = await api("/api/runners/pairing", { method: "POST", token: user });
  expect(codeRes.status).toBe(201);
  const { code } = (await codeRes.json()) as { code: string };
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  // Typed in lower case and without the dash, it still works.
  const res = await api("/api/runner/pair", {
    method: "POST",
    body: JSON.stringify({ code: code.replace("-", "").toLowerCase(), name: "Laptop", hostname: "mbp", platform: "darwin" }),
  });
  expect(res.status).toBe(201);
  return { code, ...((await res.json()) as { runner: { id: string }; token: string }) };
}

/** Plays the myrel-runner side of the WebSocket. */
async function connectRunner(token: string, features: string[] = []) {
  const res = await api("/api/runner/connect", { token, headers: { upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const frames: ServerToRunner[] = [];
  ws.addEventListener("message", (e) => {
    frames.push(JSON.parse(e.data as string) as ServerToRunner);
  });
  ws.accept();
  const send = (frame: unknown) => ws.send(JSON.stringify(frame));
  send({
    type: "hello",
    protocol: RUNNER_PROTOCOL_VERSION,
    version: "0.1.0",
    hostname: "mbp",
    platform: "darwin",
    folders: [{ path: "/Users/ismail/code/myrel", name: "myrel" }],
    clis: [{ id: "claude", version: "2.1.0" }],
    features,
    running: [],
  });
  return { ws, frames, send };
}

async function until<T>(fn: () => T | Promise<T>, what: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 160; i++) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A project chat socket, which also tells the project its public address (the sandbox calls back there). */
async function openChat(projectId: string, user: string) {
  const ws = (await api(`/api/projects/${projectId}/ws?token=${encodeURIComponent(user)}`, { headers: { upgrade: "websocket" } })).webSocket!;
  ws.accept();
  return ws;
}

/** Opens a thread in the project and starts its agent. */
/** The account behind a session token. */
async function idOf(token: string): Promise<string> {
  return ((await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } }).user.id;
}

/** A thread asked for by `token`'s person: a local turn runs only for the computer's owner. */
async function startThread(projectId: string, token: string) {
  const projectAgent = await getAgentByName(env.PROJECT_AGENT, projectId);
  const author = await idOf(token);
  const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: author, body: "x" });
  const thread = await projectAgent.createThread(root.id, "Testler");
  const threadAgent = await getAgentByName(env.THREAD_AGENT, thread.id);
  await threadAgent.start({ projectId, threadId: thread.id, brief: "x" });
  return { projectAgent, threadAgent, thread, author };
}

const listRunners = async (token: string) =>
  ((await (await api("/api/runners", { token })).json()) as { runners: Runner[] }).runners;

afterEach(resetFakeModel);

describe("pairing", () => {
  it("trades a single-use code for a runner token", async () => {
    const user = await signUp();
    const { code, runner } = await pair(user);
    expect(runner.id).toMatch(/^rnr_/);

    const again = await api("/api/runner/pair", { method: "POST", body: JSON.stringify({ code, name: "Other" }) });
    expect(again.status).toBe(400);

    const list = await listRunners(user);
    expect(list).toEqual([expect.objectContaining({ id: runner.id, name: "Laptop", online: false, folders: [] })]);
    expect(await listRunners(await signUp())).toEqual([]);
  });

  it("tells a runner whether its token is still valid", async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    const me = (t?: string) => api("/api/runner/me", { token: t });
    expect(await (await me(token)).json()).toEqual({ runner: { id: runner.id, name: "Laptop" } });
    expect((await me()).status).toBe(401);
    expect((await api(`/api/runners/${runner.id}`, { method: "DELETE", token: user })).status).toBe(200);
    expect((await me(token)).status).toBe(401);
  });

  it("refuses connections without a valid token", async () => {
    expect((await api("/api/runner/connect", { headers: { upgrade: "websocket" } })).status).toBe(401);
    expect((await api("/api/runner/connect", { token: "art_nope", headers: { upgrade: "websocket" } })).status).toBe(401);
    expect((await api("/api/runners/pairing", { method: "POST" })).status).toBe(401);
  });
});

describe("local workspace", () => {
  it("shows the runner online with its folders and binds a project to a shared folder", async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    const { ws, frames } = await connectRunner(token);
    await until(() => frames.find((f) => f.type === "welcome"), "welcome");
    const online = await until(async () => (await listRunners(user)).find((r) => r.online && r.folders.length), "hello");
    expect(online).toMatchObject({ hostname: "mbp", version: "0.1.0", clis: [{ id: "claude", version: "2.1.0" }] });

    const project = await createProject(user);
    const put = (body: unknown, token = user) =>
      api(`/api/projects/${project.id}/workspace`, { method: "PUT", token, body: JSON.stringify(body) });
    expect((await put({ runnerId: runner.id, path: "/etc", cli: "claude" })).status).toBe(400);
    // Someone else's computer is not an option.
    const stranger = await pair(await signUp());
    expect((await put({ runnerId: stranger.runner.id, path: "/Users/ismail/code/myrel", cli: "claude" })).status).toBe(400);

    const ok = await put({ runnerId: runner.id, path: "/Users/ismail/code/myrel", cli: "claude" });
    expect(ok.status).toBe(200);
    const get = async () =>
      ((await (await api(`/api/projects/${project.id}/workspace`, { token: user })).json()) as {
        workspace: ProjectWorkspace | null;
      }).workspace;
    expect(await get()).toMatchObject({ runnerName: "Laptop", path: "/Users/ismail/code/myrel", cli: "claude", online: true });

    ws.close();
    await until(async () => (await get())?.online === false, "offline");

    // Unpairing removes the computer and the project's folder with it.
    expect((await api(`/api/runners/${runner.id}`, { method: "DELETE", token: user })).status).toBe(200);
    expect(await get()).toBeNull();
    expect((await api("/api/runner/connect", { token, headers: { upgrade: "websocket" } })).status).toBe(401);
  });

  it("browses and shares the computer's folders from the web app", async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    const dirs = (path = "") => api(`/api/runners/${runner.id}/dirs?path=${encodeURIComponent(path)}`, { token: user });
    const share = (path: string, as = user) =>
      api(`/api/runners/${runner.id}/folders`, { method: "POST", token: as, body: JSON.stringify({ path }) });
    const unshare = (path: string) =>
      api(`/api/runners/${runner.id}/folders?path=${encodeURIComponent(path)}`, { method: "DELETE", token: user });
    const failure = async (res: Response) => ({ status: res.status, ...((await res.json()) as { message?: string }) });

    expect(await failure(await dirs())).toMatchObject({ status: 409, message: expect.stringContaining("offline") });

    // A runner from before this feature is asked to update instead of being sent frames it does not know.
    const old = await connectRunner(token);
    await until(async () => (await listRunners(user)).find((r) => r.online && r.folders.length), "hello");
    expect(await failure(await dirs())).toMatchObject({ status: 409, message: expect.stringContaining("Update myrel-runner") });
    old.ws.close();

    const { ws, frames, send } = await connectRunner(token, ["folders", "from-the-future"]);
    let folders = [{ path: "/Users/ismail/code/myrel", name: "myrel" }];
    ws.addEventListener("message", (e) => {
      const frame = JSON.parse(e.data as string) as ServerToRunner;
      if (frame.type === "dirs.list") {
        if (frame.path === "/nope") return send({ type: "request.failed", requestId: frame.requestId, message: "/nope does not exist" });
        send({
          type: "dirs",
          requestId: frame.requestId,
          path: frame.path ?? "/Users/ismail",
          parent: "/Users",
          home: "/Users/ismail",
          dirs: [{ name: "code", path: "/Users/ismail/code" }],
        });
      }
      if (frame.type === "folder.share") {
        folders = [...folders, { path: frame.path, name: frame.path.split("/").at(-1)! }];
        send({ type: "folders", requestId: frame.requestId, folders });
      }
      if (frame.type === "folder.unshare") {
        folders = folders.filter((f) => f.path !== frame.path);
        send({ type: "folders", requestId: frame.requestId, folders });
      }
    });
    await until(() => frames.find((f) => f.type === "welcome"), "welcome");
    expect(await until(async () => (await listRunners(user)).find((r) => r.features.includes("folders")), "features")).toMatchObject({
      features: ["folders"],
    });

    const listing = await dirs();
    expect(listing.status).toBe(200);
    expect(await listing.json()).toEqual({
      path: "/Users/ismail",
      parent: "/Users",
      home: "/Users/ismail",
      dirs: [{ name: "code", path: "/Users/ismail/code" }],
    });
    expect(await failure(await dirs("/nope"))).toMatchObject({ status: 409, message: "/nope does not exist" });

    // Only the computer's owner can browse or share.
    expect((await share("/Users/ismail/code/site", await signUp())).status).toBe(404);
    expect((await share("/Users/ismail/code/site")).status).toBe(200);
    const [after] = await listRunners(user);
    expect(after!.folders.map((f) => f.path)).toEqual(["/Users/ismail/code/myrel", "/Users/ismail/code/site"]);

    // Stopping sharing a folder takes it away from projects working in it.
    const project = await createProject(user);
    const body = JSON.stringify({ runnerId: runner.id, path: "/Users/ismail/code/site", cli: "claude" });
    expect((await api(`/api/projects/${project.id}/workspace`, { method: "PUT", token: user, body })).status).toBe(200);
    expect((await unshare("/Users/ismail/code/site")).status).toBe(200);
    const workspace = await api(`/api/projects/${project.id}/workspace`, { token: user });
    expect(((await workspace.json()) as { workspace: unknown }).workspace).toBeNull();
    expect((await listRunners(user))[0]!.folders.map((f) => f.path)).toEqual(["/Users/ismail/code/myrel"]);
    ws.close();
  });

  it("lets the person's Claude Code be the thread's agent, talking through Myrel's tools over MCP", { timeout: 20_000 }, async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    const runnerSide = await connectRunner(token, ["cancel", "agent"]);
    await until(async () => (await listRunners(user))[0]?.folders.length, "hello");
    const project = await createProject(user);
    await api(`/api/projects/${project.id}/workspace`, {
      method: "PUT",
      token: user,
      body: JSON.stringify({ runnerId: runner.id, path: "/Users/ismail/code/myrel", cli: "claude" }),
    });
    const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const author = await idOf(user);
    const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: author, body: "README'yi özetle" });
    const thread = await projectAgent.createThread(root.id, "README özeti");
    const threadAgent = await getAgentByName(env.THREAD_AGENT, thread.id);
    await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Summarize the README." });

    type Start = Extract<ServerToRunner, { type: "task.start" }>;
    const starts = () => runnerSide.frames.filter((f): f is Start => f.type === "task.start");
    const start = await until(() => starts()[0], "agent task.start");
    expect(start.agent?.mcpPath).toBe(`/api/agent-mcp/${thread.id}`);
    expect(start.prompt).toContain("You run as Claude Code on the person's own computer");
    expect(start.prompt).toContain("Summarize the README.");

    const mcp = (body: unknown, bearer = start.agent!.token) =>
      api(start.agent!.mcpPath, { method: "POST", headers: { authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
    expect((await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "x".repeat(43))).status).toBe(401);
    expect((await api(start.agent!.mcpPath)).status).toBe(405);

    const init = (await (await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json()) as {
      result: { protocolVersion: string };
    };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = (await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string }[] } };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["reply", "update_plan", "ask_decision", "request_coordinator", "memory_read"]));
    expect(names).not.toContain("run_task");

    const call = (id: number, name: string, args: unknown) => mcp({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const planned = (await (await call(3, "update_plan", { title: "README", steps: [{ text: "Oku", state: "active" }] })).json()) as {
      result: { isError: boolean };
    };
    expect(planned.result.isError).toBe(false);
    // The CLI's usage so far, as the runner reports it; only usage, so no new step is shown.
    runnerSide.send({ type: "task.progress", taskId: start.taskId, text: "", usage: { inputTokens: 1200, outputTokens: 80, model: "claude-sonnet-5-5" } });
    await new Promise((r) => setTimeout(r, 200));
    await call(4, "reply", { text: "README'yi okuyorum." });
    const messages = async () => (await projectAgent.getThreadContext(thread.id))?.messages ?? [];
    const bodies = async () => (await messages()).map((m) => m.body);
    expect(await bodies()).toContain("README'yi okuyorum.");
    // Its reply carries the line the coordinator's do: where, which CLI and model, tokens; no price on their own CLI.
    const first = (await messages()).find((m) => m.body === "README'yi okuyorum.")!;
    expect(first.stats).toMatchObject({
      runtime: "local",
      harness: "claude",
      model: "claude-sonnet-5-5",
      inputTokens: 1200,
      outputTokens: 80,
      costMicros: null,
    });

    // A message during the turn waits for it instead of starting a second agent.
    const followUp = await projectAgent.sendMessage({ threadId: thread.id, authorKind: "user", authorId: author, body: "kısa tut" });
    await threadAgent.wake({ kind: "message", messageId: followUp.id });
    await new Promise((r) => setTimeout(r, 200));
    expect(starts()).toHaveLength(1);

    runnerSide.send({
      type: "task.done",
      taskId: start.taskId,
      ok: true,
      result: "Summary posted.",
      usage: { inputTokens: 1500, outputTokens: 120, model: "claude-sonnet-5-5" },
    });
    // What it used after its last reply joins that reply.
    await until(async () => (await messages()).find((m) => m.id === first.id)?.stats?.inputTokens === 1500, "tail usage");
    expect((await messages()).find((m) => m.id === first.id)!.stats!.outputTokens).toBe(120);
    // The turn's token dies with it, and the waiting message gets the next turn.
    await until(async () => (await mcp({ jsonrpc: "2.0", id: 5, method: "tools/list" })).status === 401, "token revoked");
    const next = await until(() => starts()[1], "next agent turn");
    expect(next.prompt).toContain("kısa tut");
    expect(next.agent?.token).not.toBe(start.agent!.token);
    // It replied itself, so its final message is not posted again.
    expect((await bodies()).filter((b) => b === "Summary posted.")).toHaveLength(0);

    runnerSide.send({ type: "task.done", taskId: next.taskId, ok: true, result: "Kısa özet: Myrel bir proje asistanı." });
    await until(async () => (await bodies()).includes("Kısa özet: Myrel bir proje asistanı."), "final message as reply");
    // A runner that reports no usage still gets the line, without tokens.
    expect((await messages()).find((m) => m.body.startsWith("Kısa özet"))!.stats).toMatchObject({ runtime: "local", harness: "claude", inputTokens: 0 });
    await until(async () => (await projectAgent.getThread(thread.id))?.status === "review_ready", "idle");
    runnerSide.ws.close();
  });

  it("works in the project's folders and asks the person before reaching outside them", { timeout: 30_000 }, async () => {
    const res = await api("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: `u${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "İsmail" }),
    });
    const user = res.headers.get("set-auth-token")!;
    const me = ((await res.json()) as { user: { id: string } }).user.id;
    const { runner, token } = await pair(user);
    const runnerSide = await connectRunner(token, ["cancel", "agent", "folders", "project-folders"]);
    let shared = [{ path: "/Users/ismail/code/myrel", name: "myrel" }];
    runnerSide.ws.addEventListener("message", (e) => {
      const frame = JSON.parse(e.data as string) as ServerToRunner;
      if (frame.type === "folder.share") {
        shared = [...shared, { path: frame.path, name: frame.path.split("/").at(-1)! }];
        runnerSide.send({ type: "folders", requestId: frame.requestId, folders: shared });
      }
    });
    await until(async () => (await listRunners(user))[0]?.folders.length, "hello");
    const project = await createProject(user);
    const workspace = async () =>
      ((await (await api(`/api/projects/${project.id}/workspace`, { token: user })).json()) as { workspace: ProjectWorkspace }).workspace;
    const addFolder = (path: string) =>
      api(`/api/projects/${project.id}/workspace/folders`, { method: "POST", token: user, body: JSON.stringify({ path }) });
    // No local folder yet, so no other folders either.
    expect((await addFolder("/Users/ismail/code/myrel")).status).toBe(400);
    await api(`/api/projects/${project.id}/workspace`, {
      method: "PUT",
      token: user,
      body: JSON.stringify({ runnerId: runner.id, path: "/Users/ismail/code/myrel", cli: "claude" }),
    });
    // Only a folder shared on that computer.
    expect((await addFolder("/Users/ismail/docs")).status).toBe(400);
    expect((await api(`/api/runners/${runner.id}/folders`, { method: "POST", token: user, body: JSON.stringify({ path: "/Users/ismail/docs" }) })).status).toBe(200);
    expect((await addFolder("/Users/ismail/docs")).status).toBe(200);
    expect((await workspace()).folders).toEqual(["/Users/ismail/docs"]);
    // A project admin who does not own the computer cannot add its other shared folders.
    const otherEmail = `u${crypto.randomUUID()}@example.com`;
    const other = (
      await api("/api/auth/sign-up/email", {
        method: "POST",
        body: JSON.stringify({ email: otherEmail, password: "correct-horse-battery", name: "Ada" }),
      })
    ).headers.get("set-auth-token")!;
    const invited = await api(`/api/projects/${project.id}/invites`, { method: "POST", token: user, body: JSON.stringify({ email: otherEmail, role: "admin" }) });
    const { invite } = (await invited.json()) as { invite: { id: string } };
    expect((await api(`/api/account/invites/${invite.id}/accept`, { method: "POST", token: other })).status).toBe(200);
    const byAdmin = await api(`/api/projects/${project.id}/workspace/folders`, { method: "POST", token: other, body: JSON.stringify({ path: "/Users/ismail/code/myrel" }) });
    expect(byAdmin.status).toBe(403);

    const { projectAgent, thread } = await startThread(project.id, user);
    type Start = Extract<ServerToRunner, { type: "task.start" }>;
    const start = await until(() => runnerSide.frames.find((f): f is Start => f.type === "task.start"), "task.start");
    expect(start.folders).toEqual(["/Users/ismail/docs"]);
    expect(start.prompt).toContain("/Users/ismail/code/myrel and /Users/ismail/docs");
    expect(start.prompt).toContain("Myrel asks the person for you");
    // The CLI works in a worktree, with the project's folders added.
    runnerSide.send({ type: "task.folders", taskId: start.taskId, folders: ["/Users/ismail/.myrel-runner/worktrees/x", "/Users/ismail/code/myrel", "/Users/ismail/docs"] });
    await new Promise((r) => setTimeout(r, 100));

    const mcp = (body: unknown) =>
      api(start.agent!.mcpPath, { method: "POST", headers: { authorization: `Bearer ${start.agent!.token}` }, body: JSON.stringify(body) });
    let id = 10;
    const ask = async (tool_name: string, input: Record<string, unknown>) => {
      const raw = await mcp({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "approve_access", arguments: { tool_name, input } } });
      const res = (await raw.json()) as {
        result: { content: { text: string }[] };
      };
      return JSON.parse(res.result.content[0]!.text) as { behavior: string; message?: string };
    };
    const cards = async () =>
      ((await projectAgent.getThreadContext(thread.id))?.messages ?? []).filter((m) => m.body.includes("```decision"));
    const answer = async (body: string) => {
      const m = await projectAgent.sendMessage({ threadId: thread.id, authorKind: "user", authorId: me, body });
      const agent = await getAgentByName(env.THREAD_AGENT, thread.id);
      await agent.wake({ kind: "message", messageId: m.id, body, authorId: me, seq: m.seq });
    };

    // Inside its folders, a question is about the runner's access level, which stays as it is.
    expect(await ask("Bash", { command: "rm -rf build" })).toMatchObject({ behavior: "deny", message: expect.stringContaining("access level") });
    expect((await ask("Edit", { file_path: "src/../src/a.ts" })).behavior).toBe("deny");
    expect(await cards()).toHaveLength(0);

    // Outside them, the person is asked and the step waits for the answer.
    const once = ask("Read", { file_path: "/Users/ismail/notes/todo.md" });
    const [card] = await until(async () => ((await cards()).length ? cards() : null), "folder card");
    expect(card!.body).toContain("/Users/ismail/notes");
    expect((await projectAgent.getThread(thread.id))?.status).toBe("blocked");
    // Ada, an admin of the project, does not answer for İsmail's computer.
    const ada = await idOf(other);
    const agent = await getAgentByName(env.THREAD_AGENT, thread.id);
    const byAda = await projectAgent.sendMessage({ threadId: thread.id, authorKind: "user", authorId: ada, body: "Bu sefer izin ver" });
    await agent.wake({ kind: "message", messageId: byAda.id, body: byAda.body, authorId: ada, seq: byAda.seq });
    const pending = await Promise.race([once.then(() => "answered"), new Promise((r) => setTimeout(() => r("waiting"), 300))]);
    expect(pending).toBe("waiting");
    await answer("Bu sefer izin ver");
    expect((await once).behavior).toBe("allow");
    // Allowed once: the rest of this turn uses it without asking again.
    expect((await ask("Grep", { pattern: "TODO", path: "/Users/ismail/notes/2026" })).behavior).toBe("allow");
    expect(await cards()).toHaveLength(1);

    const refused = ask("Read", { file_path: "/Users/ismail/.ssh/id_ed25519" });
    await until(async () => (await cards()).length === 2, "second card");
    await answer("İzin verme");
    expect((await refused).behavior).toBe("deny");

    // Two folders at once: one card at a time, and an answer is for that card's folder only.
    const first = ask("Read", { file_path: "/Users/ismail/a/x.md" });
    await until(async () => (await cards()).length === 3, "first of two cards");
    const second = ask("Read", { file_path: "/Users/ismail/b/y.md" });
    await new Promise((r) => setTimeout(r, 300));
    expect(await cards()).toHaveLength(3);
    await answer("Bu sefer izin ver");
    expect((await first).behavior).toBe("allow");
    await until(async () => (await cards()).length === 4, "second of two cards");
    expect((await cards())[3]!.body).toContain("/Users/ismail/b");
    await answer("İzin verme");
    expect((await second).behavior).toBe("deny");

    // Added to the project: shared on the computer and listed in the project's settings.
    const always = ask("Glob", { pattern: "/Users/ismail/code/site/**/*.md" });
    await until(async () => (await cards()).length === 5, "fifth card");
    await answer("Projeye ekle");
    expect((await always).behavior).toBe("allow");
    expect((await workspace()).folders).toEqual(["/Users/ismail/docs", "/Users/ismail/code/site"]);
    expect(shared.map((f) => f.path)).toContain("/Users/ismail/code/site");
    // Answers to the cards did not queue another turn; Ada's message, an ordinary one, queued one.
    runnerSide.send({ type: "task.done", taskId: start.taskId, ok: true, result: "Done." });
    await until(async () => (await projectAgent.getThread(thread.id))?.status === "review_ready", "idle");
    await new Promise((r) => setTimeout(r, 200));
    expect(runnerSide.frames.filter((f) => f.type === "task.start")).toHaveLength(2);
    runnerSide.ws.close();
  });

  it("asks the person to update a runner that cannot host the agent", async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    const runnerSide = await connectRunner(token, ["cancel"]);
    await until(async () => (await listRunners(user))[0]?.folders.length, "hello");
    const project = await createProject(user);
    await api(`/api/projects/${project.id}/workspace`, {
      method: "PUT",
      token: user,
      body: JSON.stringify({ runnerId: runner.id, path: "/Users/ismail/code/myrel", cli: "claude" }),
    });
    const { projectAgent, thread } = await startThread(project.id, user);
    const notice = await until(
      async () => (await projectAgent.getThreadContext(thread.id))?.messages.find((m) => m.authorKind === "system"),
      "the notice",
    );
    expect(notice.body).toContain("npx myrel-runner@latest update");
    expect((await projectAgent.getThread(thread.id))?.status).toBe("blocked");
    expect(runnerSide.frames.some((f) => f.type === "task.start")).toBe(false);
    runnerSide.ws.close();
  });

  it("runs another member's thread in the cloud, never on the folder owner's computer", { timeout: 20_000 }, async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    const runnerSide = await connectRunner(token, ["cancel", "agent"]);
    await until(async () => (await listRunners(user))[0]?.folders.length, "hello");
    const project = await createProject(user);
    await api(`/api/projects/${project.id}/workspace`, {
      method: "PUT",
      token: user,
      body: JSON.stringify({ runnerId: runner.id, path: "/Users/ismail/code/myrel", cli: "claude" }),
    });
    const email = `m${crypto.randomUUID()}@example.com`;
    const member = (
      await api("/api/auth/sign-up/email", {
        method: "POST",
        body: JSON.stringify({ email, password: "correct-horse-battery", name: "Ada" }),
      })
    ).headers.get("set-auth-token")!;
    const invited = await api(`/api/projects/${project.id}/invites`, { method: "POST", token: user, body: JSON.stringify({ email }) });
    const { invite } = (await invited.json()) as { invite: { id: string } };
    expect((await api(`/api/account/invites/${invite.id}/accept`, { method: "POST", token: member })).status).toBe(200);

    // Auto: the member's thread goes to the sandbox, which this test runtime does not have.
    await openChat(project.id, user);
    const { threadAgent } = await startThread(project.id, member);
    await until(async () => (await threadAgent.getTasks())[0]?.status === "failed", "the cloud turn");
    expect((await threadAgent.getTasks())[0]).toMatchObject({ backend: "sandbox" });
    expect(runnerSide.frames.some((f) => f.type === "task.start")).toBe(false);

    // Local only: the member's thread says why it cannot run, and still nothing reaches the computer.
    await api(`/api/projects/${project.id}/settings`, { method: "PATCH", token: user, body: JSON.stringify({ taskTarget: "local" }) });
    const second = await startThread(project.id, member);
    const bodies = async () => ((await second.projectAgent.getThreadContext(second.thread.id))?.messages ?? []).map((m) => m.body);
    await until(async () => (await bodies()).some((b) => b.includes("only the person whose computer that is")), "the refusal");
    expect(runnerSide.frames.some((f) => f.type === "task.start")).toBe(false);
    runnerSide.ws.close();
  });

  it("runs the agent where the project's setting says and stops it on the computer", { timeout: 20_000 }, async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    const runnerSide = await connectRunner(token, ["cancel", "agent"]);
    await until(async () => (await listRunners(user))[0]?.folders.length, "hello");
    const project = await createProject(user);
    await api(`/api/projects/${project.id}/workspace`, {
      method: "PUT",
      token: user,
      body: JSON.stringify({ runnerId: runner.id, path: "/Users/ismail/code/myrel", cli: "claude" }),
    });
    const chat = await openChat(project.id, user);
    const { projectAgent, threadAgent, thread, author } = await startThread(project.id, user);
    const bodies = async () => ((await projectAgent.getThreadContext(thread.id))?.messages ?? []).map((m) => m.body);

    // Auto: the computer is online, so the turn goes there.
    const start = await until(
      () => runnerSide.frames.find((f): f is Extract<ServerToRunner, { type: "task.start" }> => f.type === "task.start"),
      "task.start",
    );
    const cancel = await api(`/api/projects/${project.id}/threads/${thread.id}/tasks/${start.taskId}/cancel`, { method: "POST", token: user, body: "{}" });
    expect(cancel.status).toBe(200);
    await until(() => runnerSide.frames.some((f) => f.type === "task.cancel" && f.taskId === start.taskId), "task.cancel");
    runnerSide.send({ type: "task.done", taskId: start.taskId, ok: false, cancelled: true, result: "Stopped from Myrel." });
    await until(async () => (await threadAgent.getTasks())[0]?.status === "cancelled", "cancelled");
    expect((await threadAgent.getTasks())[0]).toMatchObject({ backend: "local", harness: "claude", title: "Claude Code" });
    await until(async () => (await bodies()).some((b) => b.startsWith('The task "Claude Code" was cancelled.')), "the report");

    // Cloud: the same project sends the next turn to the sandbox, which this test runtime does not have.
    await api(`/api/projects/${project.id}/settings`, { method: "PATCH", token: user, body: JSON.stringify({ taskTarget: "cloud" }) });
    const next = await projectAgent.sendMessage({ threadId: thread.id, authorKind: "user", authorId: author, body: "again" });
    await threadAgent.wake({ kind: "message", messageId: next.id });
    await until(async () => (await threadAgent.getTasks())[1]?.status === "failed", "cloud turn");
    expect((await threadAgent.getTasks())[1]).toMatchObject({ backend: "sandbox", harness: "opencode" });

    // Local with the computer offline: the thread says why it cannot work.
    await api(`/api/projects/${project.id}/settings`, { method: "PATCH", token: user, body: JSON.stringify({ taskTarget: "local" }) });
    runnerSide.ws.close();
    await until(async () => !(await listRunners(user))[0]?.online, "offline");
    const last = await projectAgent.sendMessage({ threadId: thread.id, authorKind: "user", authorId: author, body: "once more" });
    await threadAgent.wake({ kind: "message", messageId: last.id });
    await until(async () => (await bodies()).some((b) => b.includes("it is offline")), "offline notice");
    chat.close();
  });

  it("keeps a project without a local folder in the cloud, even with the computer online", async () => {
    const user = await signUp();
    const { token } = await pair(user);
    const runnerSide = await connectRunner(token, ["cancel", "agent"]);
    await until(async () => (await listRunners(user))[0]?.online, "online");
    const project = await createProject(user);
    expect(((await (await api(`/api/projects/${project.id}/workspace`, { token: user })).json()) as { workspace: unknown }).workspace).toBeNull();
    const chat = await openChat(project.id, user);
    const { threadAgent } = await startThread(project.id, user);
    await until(async () => (await threadAgent.getTasks())[0]?.status === "failed", "cloud turn");
    expect((await threadAgent.getTasks())[0]).toMatchObject({ backend: "sandbox" });
    expect(runnerSide.frames.some((f) => f.type === "task.start")).toBe(false);
    chat.close();
    runnerSide.ws.close();
  });

  it("asks older runners to update before stopping their tasks", async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    const runnerSide = await connectRunner(token);
    await until(async () => (await listRunners(user))[0]?.folders.length, "hello");
    const runnerAgent = await getAgentByName(env.RUNNER_AGENT, runner.id);
    const taskId = "task_01JTEST0000000000000000009";
    await runnerAgent.startTask({ taskId, projectId: "proj_x", threadId: "thr_01JTEST0000000000000000000", folder: "/x", cli: "claude", prompt: "p" });
    expect(await runnerAgent.cancelTask(taskId)).toMatchObject({ ok: false, reason: expect.stringContaining("Update myrel-runner") });
    runnerSide.ws.close();
  });
});
