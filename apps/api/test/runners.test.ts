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
async function connectRunner(token: string, features: string[] = [], hello: Record<string, unknown> = {}) {
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
    ...hello,
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

    // A file inside its folders asks only when the runner is read-only, which stays as it is.
    expect(await ask("Edit", { file_path: "src/../src/a.ts" })).toMatchObject({ behavior: "deny", message: expect.stringContaining("access level") });
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

    // A command the runner does not run on its own is put to the person instead of a restart.
    const run = ask("Bash", { command: "git push -u origin myrel/readme" });
    await until(async () => (await cards()).length === 6, "command card");
    expect((await cards())[5]!.body).toContain("git push -u origin myrel/readme");
    // A folder card's answer is not an answer to it.
    await answer("Bu sefer izin ver");
    expect(await Promise.race([run.then(() => "answered"), new Promise((r) => setTimeout(() => r("waiting"), 300))])).toBe("waiting");
    await answer("Çalıştır");
    expect((await run).behavior).toBe("allow");
    // Answered, the card shrinks to the command and the card, without the explanation.
    await until(async () => !(await cards())[5]!.body.includes("erişim seviyesi"), "shortened card");
    expect((await cards())[5]!.body.startsWith("`git push -u origin myrel/readme`")).toBe(true);
    // Pull requests go through Myrel's GitHub App, never gh, whatever the person allowed.
    expect(await ask("Bash", { command: "git push && gh pr create --fill" })).toMatchObject({ behavior: "deny", message: expect.stringContaining("open_pull_request") });
    const denied = ask("Bash", { command: "rm -rf build" });
    await until(async () => (await cards()).length === 7, "second command card");
    await answer("Çalıştırma");
    expect((await denied).behavior).toBe("deny");
    const all = ask("Bash", { command: "pnpm test" });
    await until(async () => (await cards()).length === 8, "third command card");
    await answer("Bu çalışmada hep izin ver");
    expect((await all).behavior).toBe("allow");
    // Commands are allowed for the rest of the turn.
    expect((await ask("Bash", { command: "git status" })).behavior).toBe("allow");
    expect(await cards()).toHaveLength(8);
    // Answers to the cards did not queue another turn; Ada's message, an ordinary one, queued one.
    runnerSide.send({ type: "task.done", taskId: start.taskId, ok: true, result: "Done." });
    await until(async () => (await projectAgent.getThread(thread.id))?.status === "review_ready", "idle");
    await new Promise((r) => setTimeout(r, 200));
    const turns = runnerSide.frames.filter((f): f is Start => f.type === "task.start");
    expect(turns).toHaveLength(2);
    // The first turn has no session to continue; the second can continue the first's with only what is new.
    expect(turns[0]!.agent?.resume).toBeUndefined();
    expect(turns[1]!.agent?.resume?.after).toBe(start.taskId);
    expect(turns[1]!.agent!.resume!.prompt).toContain("New in the thread since your last turn");
    expect(turns[1]!.agent!.resume!.prompt).toContain("Bu sefer izin ver");
    expect(turns[1]!.agent!.resume!.prompt).not.toContain("The message this thread started from");
    expect(turns[1]!.prompt).toContain("The message this thread started from");
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

  it("drops Gemini CLI from older runners and asks for another CLI where a folder still uses it", async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    const clis = [{ id: "claude", version: "2.1.0" }, { id: "gemini", version: "0.40.0" }];
    const runnerSide = await connectRunner(token, ["cancel", "agent", "agent-clis"], { clis });
    const online = await until(async () => (await listRunners(user)).find((r) => r.online && r.folders.length), "hello");
    expect(online.clis).toEqual([{ id: "claude", version: "2.1.0" }]);
    const project = await createProject(user);
    const body = JSON.stringify({ runnerId: runner.id, path: "/Users/ismail/code/myrel", cli: "gemini" });
    expect((await api(`/api/projects/${project.id}/workspace`, { method: "PUT", token: user, body })).status).toBe(400);
    // A folder saved before Gemini CLI was dropped.
    await api(`/api/projects/${project.id}/workspace`, {
      method: "PUT",
      token: user,
      body: JSON.stringify({ runnerId: runner.id, path: "/Users/ismail/code/myrel", cli: "claude" }),
    });
    await env.DB.prepare("UPDATE project_workspaces SET cli = 'gemini' WHERE project_id = ?").bind(project.id).run();
    const { projectAgent, thread } = await startThread(project.id, user);
    const notice = await until(
      async () => (await projectAgent.getThreadContext(thread.id))?.messages.find((m) => m.authorKind === "system"),
      "the notice",
    );
    expect(notice.body).toContain("no longer supports the CLI");
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

  it("continues a turn the runner's restart cut off, a bounded number of times", { timeout: 30_000 }, async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    let runnerSide = await connectRunner(token, ["cancel", "agent"]);
    await until(async () => (await listRunners(user))[0]?.folders.length, "hello");
    const project = await createProject(user);
    await api(`/api/projects/${project.id}/workspace`, {
      method: "PUT",
      token: user,
      body: JSON.stringify({ runnerId: runner.id, path: "/Users/ismail/code/myrel", cli: "claude" }),
    });
    const { projectAgent, threadAgent, thread } = await startThread(project.id, user);
    const bodies = async () => ((await projectAgent.getThreadContext(thread.id))?.messages ?? []).map((m) => m.body);
    type Start = Extract<ServerToRunner, { type: "task.start" }>;
    const startOn = (side: typeof runnerSide) => until(() => side.frames.find((f): f is Start => f.type === "task.start"), "task.start");
    /** The runner restarts: a new connection whose hello reports the task as interrupted. */
    const restart = async (taskId: string) => {
      runnerSide.ws.close();
      runnerSide = await connectRunner(token, ["cancel", "agent"], { interrupted: [taskId] });
    };

    const first = await startOn(runnerSide);
    runnerSide.send({ type: "task.progress", taskId: first.taskId, text: "Bash: pnpm install" });
    await until(async () => (await threadAgent.getTasks())[0]?.log.some((l) => l.text.includes("pnpm install")), "progress");
    await restart(first.taskId);
    await until(async () => (await bodies()).some((b) => b.includes("continues where it left off") && b.includes("(1/3)")), "resume notice");
    expect((await projectAgent.getThread(thread.id))?.status).toBe("working");
    expect((await bodies()).some((b) => b.includes("failed"))).toBe(false);

    // The wait is over: the same session continues, told where it stopped.
    await threadAgent.resumeInterrupted({ taskId: first.taskId });
    const second = await startOn(runnerSide);
    expect(second.prompt).toContain("Your last run was interrupted (automatic continue 1 of 3)");
    expect(second.prompt).toContain("Bash: pnpm install");
    expect(second.agent?.resume?.after).toBe(first.taskId);
    expect(second.agent?.resume?.prompt).toContain("Your last run was interrupted");

    // Cut off again before any step: that counts twice, so this is the last continue.
    await restart(second.taskId);
    await until(async () => (await bodies()).some((b) => b.includes("(2/3)")), "second resume notice");
    await threadAgent.resumeInterrupted({ taskId: second.taskId });
    const third = await startOn(runnerSide);
    await restart(third.taskId);
    await until(async () => (await bodies()).some((b) => b.includes("stopped continuing on its own")), "gave up");
    await until(async () => (await projectAgent.getThread(thread.id))?.status === "failed", "failed");
    expect((await threadAgent.getTasks()).map((t) => t.status)).toEqual(["failed", "failed", "failed"]);
    // Nothing is waiting to continue it any more.
    await threadAgent.resumeInterrupted({ taskId: third.taskId });
    await new Promise((r) => setTimeout(r, 200));
    expect(runnerSide.frames.some((f) => f.type === "task.start")).toBe(false);
    runnerSide.ws.close();
  });

  it("does not continue on its own when the computer keeps disconnecting", { timeout: 30_000 }, async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    let runnerSide = await connectRunner(token, ["cancel", "agent"]);
    await until(async () => (await listRunners(user))[0]?.folders.length, "hello");
    const project = await createProject(user);
    await api(`/api/projects/${project.id}/workspace`, {
      method: "PUT",
      token: user,
      body: JSON.stringify({ runnerId: runner.id, path: "/Users/ismail/code/myrel", cli: "claude" }),
    });
    const { projectAgent, thread } = await startThread(project.id, user);
    const bodies = async () => ((await projectAgent.getThreadContext(thread.id))?.messages ?? []).map((m) => m.body);
    await until(() => runnerSide.frames.find((f) => f.type === "task.start"), "task.start");
    // Connections that come and go without a hello reporting tasks.
    for (let i = 0; i < 5; i++) {
      runnerSide.ws.close();
      const res = await api("/api/runner/connect", { token, headers: { upgrade: "websocket" } });
      res.webSocket!.accept();
      runnerSide = { ...runnerSide, ws: res.webSocket! };
    }
    runnerSide.ws.close();
    // An older runner: no interrupted list, so the task just disappeared.
    runnerSide = await connectRunner(token, ["cancel", "agent"]);
    await until(async () => (await bodies()).some((b) => b.includes("keeps disconnecting")), "flapping notice");
    expect((await bodies()).some((b) => b.includes("The task stopped when the computer disconnected."))).toBe(true);
    await until(async () => (await projectAgent.getThread(thread.id))?.status === "failed", "failed");
    runnerSide.ws.close();
  });

  it("runs a thread with the CLI picked for it, not the folder's", { timeout: 30_000 }, async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    const clis = [{ id: "claude", version: "2.1.0" }, { id: "codex", version: "0.50.0" }];
    const runnerSide = await connectRunner(token, ["cancel", "agent", "agent-clis"], { clis });
    await until(async () => (await listRunners(user)).find((r) => r.online && r.clis.length === 2), "hello");
    const project = await createProject(user);
    await api(`/api/projects/${project.id}/workspace`, {
      method: "PUT",
      token: user,
      body: JSON.stringify({ runnerId: runner.id, path: "/Users/ismail/code/myrel", cli: "claude" }),
    });
    const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const chat = await openChat(project.id, user);
    const errors: string[] = [];
    chat.addEventListener("message", (e) => {
      const event = JSON.parse(e.data as string) as { type: string; code?: string };
      if (event.type === "error") errors.push(event.code!);
    });

    // An ask keeps the CLIs it offered that the computer has, once each and in order.
    chat.send(JSON.stringify({ type: "message.send", body: "Fix the tests", clis: ["codex", "antigravity", "codex", "claude"] }));
    const ask = await until(async () => (await projectAgent.getMessagesAfter(0)).messages.find((m) => m.body === "Fix the tests"), "the ask");
    expect(ask.clis).toEqual(["codex", "claude"]);

    // The thread runs with its own CLI.
    const author = await idOf(user);
    const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: author, body: "x" });
    const thread = await projectAgent.createThread(root.id, "Testler", null, undefined, {
      id: "codex",
      options: ["claude", "codex"],
      by: "coordinator",
      reason: "Claude Code is at its limit.",
    });
    const threadAgent = await getAgentByName(env.THREAD_AGENT, thread.id);
    await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "x" });
    const start = await until(
      () => runnerSide.frames.find((f): f is Extract<ServerToRunner, { type: "task.start" }> => f.type === "task.start"),
      "task.start",
    );
    expect(start.cli).toBe("codex");
    runnerSide.send({ type: "task.done", taskId: start.taskId, ok: true, result: "done" });
    await until(async () => (await threadAgent.getTasks())[0]?.status === "done", "the turn");
    expect((await threadAgent.getTasks())[0]).toMatchObject({ harness: "codex", title: "Codex CLI" });

    // The computer's owner switches it, but only to a CLI the computer has.
    chat.send(JSON.stringify({ type: "thread.cli", threadId: thread.id, cli: "antigravity" }));
    await until(() => errors.includes("no_cli"), "the refusal");
    expect((await projectAgent.getThread(thread.id))?.cli?.id).toBe("codex");
    chat.send(JSON.stringify({ type: "thread.cli", threadId: thread.id, cli: "claude" }));
    await until(async () => (await projectAgent.getThread(thread.id))?.cli?.id === "claude", "the switch");
    expect((await projectAgent.getThread(thread.id))?.cli).toEqual({ id: "claude", options: ["claude"], by: "person", reason: null });
    chat.send(JSON.stringify({ type: "thread.cli", threadId: thread.id, cli: null }));
    await until(async () => (await projectAgent.getThread(thread.id))?.cli === null, "back to the folder's");

    // A thread set to a CLI the computer no longer has says so instead of running.
    const other = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: author, body: "y" });
    const gone = await projectAgent.createThread(other.id, "Gone", null, undefined, { id: "antigravity", options: ["antigravity"], by: "person", reason: null });
    await (await getAgentByName(env.THREAD_AGENT, gone.id)).start({ projectId: project.id, threadId: gone.id, brief: "y" });
    const notice = await until(
      async () => (await projectAgent.getThreadContext(gone.id))?.messages.find((m) => m.authorKind === "system"),
      "the notice",
    );
    expect(notice.body).toContain("Antigravity CLI is not available on Laptop");
    expect(runnerSide.frames.filter((f) => f.type === "task.start")).toHaveLength(1);
    chat.close();
    runnerSide.ws.close();
  });

  it("ignores CLIs offered by someone whose computer it is not", async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    const runnerSide = await connectRunner(token, ["cancel", "agent"]);
    await until(async () => (await listRunners(user))[0]?.online, "online");
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
    const chat = await openChat(project.id, member);
    chat.send(JSON.stringify({ type: "message.send", body: "Mine", clis: ["claude"] }));
    const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const ask = await until(async () => (await projectAgent.getMessagesAfter(0)).messages.find((m) => m.body === "Mine"), "the ask");
    expect(ask.clis).toBeUndefined();
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

describe("runner settings and updates", () => {
  it("shows the runner's settings and changes them on the computer", async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    const settings = { access: "edit", worktrees: true, autoUpdate: false, remote: true };
    const { frames, send } = await connectRunner(token, ["folders", "settings"], { settings, updates: "service" });
    await until(async () => (await listRunners(user))[0]?.settings, "settings in the list");

    const patch = api(`/api/runners/${runner.id}`, {
      method: "PATCH",
      token: user,
      body: JSON.stringify({ name: "Work laptop", settings: { access: "full" } }),
    });
    const asked = await until(() => frames.find((f) => f.type === "settings.set"), "settings.set");
    if (asked.type !== "settings.set") throw new Error("unreachable");
    expect(asked.settings).toEqual({ access: "full" });
    send({ type: "settings", requestId: asked.requestId, settings: { ...settings, access: "full" } });
    const res = await patch;
    expect(res.status).toBe(200);
    const { runner: changed } = (await res.json()) as { runner: Runner };
    expect(changed).toMatchObject({ name: "Work laptop", settings: { access: "full" }, updates: "service" });
  });

  it("says why a computer cannot change settings or update from here", async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    const offline = await api(`/api/runners/${runner.id}`, { method: "PATCH", token: user, body: JSON.stringify({ settings: { access: "auto" } }) });
    expect(offline.status).toBe(409);
    await connectRunner(token, ["folders"]);
    await until(async () => (await listRunners(user))[0]?.online, "online");
    const old = await api(`/api/runners/${runner.id}/update`, { method: "POST", token: user, body: "{}" });
    expect(old.status).toBe(409);
    expect(((await old.json()) as { message: string }).message).toMatch(/npx myrel-runner@latest update/);
    // Only the computer's owner can change it.
    const other = await signUp();
    expect((await api(`/api/runners/${runner.id}`, { method: "PATCH", token: other, body: JSON.stringify({ name: "x" }) })).status).toBe(404);
  });

  it("asks the computer to update to the newest version and shows how it goes", async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    const list = (await (await api("/api/runners", { token: user })).json()) as { latestVersion: string | null };
    expect(list.latestVersion).toBe("0.13.0");
    const { frames, send } = await connectRunner(token, ["folders", "update"], { updates: "service" });
    await until(async () => (await listRunners(user))[0]?.online, "online");

    const req = api(`/api/runners/${runner.id}/update`, { method: "POST", token: user, body: JSON.stringify({ now: false }) });
    const asked = await until(() => frames.find((f) => f.type === "runner.update"), "runner.update");
    if (asked.type !== "runner.update") throw new Error("unreachable");
    expect(asked).toMatchObject({ version: "0.13.0", now: false });
    const at = new Date().toISOString();
    send({ type: "update.accepted", requestId: asked.requestId, update: { state: "waiting", version: "0.13.0", running: 1, at } });
    expect(((await (await req).json()) as { runner: Runner }).runner.update).toMatchObject({ state: "waiting", running: 1 });

    send({ type: "update.status", update: { state: "restarting", version: "0.13.0", at } });
    await until(async () => (await listRunners(user))[0]?.update?.state === "restarting", "restarting");
    send({ type: "update.status", update: null });
    await until(async () => !(await listRunners(user))[0]?.update, "update cleared");
  });

  it("does not ask a runner that is already on the newest version", async () => {
    const user = await signUp();
    const { runner, token } = await pair(user);
    const { frames } = await connectRunner(token, ["update"], { version: "0.13.0", updates: "service" });
    await until(async () => (await listRunners(user))[0]?.version === "0.13.0", "hello");
    const res = await api(`/api/runners/${runner.id}/update`, { method: "POST", token: user, body: "{}" });
    expect(res.status).toBe(200);
    expect(frames.some((f) => f.type === "runner.update")).toBe(false);
  });
});
