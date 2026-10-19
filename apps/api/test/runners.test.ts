import type { Project, ProjectWorkspace, Runner, ServerEvent, ServerToRunner } from "@altair/protocol";
import { RUNNER_PROTOCOL_VERSION } from "@altair/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { resetFakeModel, setFakeModel } from "./fake-llm";

const BASE = "http://altair.test";

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
  const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Altair" }) });
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

/** Plays the altair-runner side of the WebSocket. */
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
    folders: [{ path: "/Users/ismail/code/altair", name: "altair" }],
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
    expect((await put({ runnerId: stranger.runner.id, path: "/Users/ismail/code/altair", cli: "claude" })).status).toBe(400);

    const ok = await put({ runnerId: runner.id, path: "/Users/ismail/code/altair", cli: "claude" });
    expect(ok.status).toBe(200);
    const get = async () =>
      ((await (await api(`/api/projects/${project.id}/workspace`, { token: user })).json()) as {
        workspace: ProjectWorkspace | null;
      }).workspace;
    expect(await get()).toMatchObject({ runnerName: "Laptop", path: "/Users/ismail/code/altair", cli: "claude", online: true });

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
    expect(await failure(await dirs())).toMatchObject({ status: 409, message: expect.stringContaining("Update altair-runner") });
    old.ws.close();

    const { ws, frames, send } = await connectRunner(token, ["folders", "from-the-future"]);
    let folders = [{ path: "/Users/ismail/code/altair", name: "altair" }];
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
    expect(after!.folders.map((f) => f.path)).toEqual(["/Users/ismail/code/altair", "/Users/ismail/code/site"]);

    // Stopping sharing a folder takes it away from projects working in it.
    const project = await createProject(user);
    const body = JSON.stringify({ runnerId: runner.id, path: "/Users/ismail/code/site", cli: "claude" });
    expect((await api(`/api/projects/${project.id}/workspace`, { method: "PUT", token: user, body })).status).toBe(200);
    expect((await unshare("/Users/ismail/code/site")).status).toBe(200);
    const workspace = await api(`/api/projects/${project.id}/workspace`, { token: user });
    expect(((await workspace.json()) as { workspace: unknown }).workspace).toBeNull();
    expect((await listRunners(user))[0]!.folders.map((f) => f.path)).toEqual(["/Users/ismail/code/altair"]);
    ws.close();
  });

  it("lets the thread agent run a task on the computer and answer with its result", async () => {
    const call = (name: string, input: unknown) => ({ id: crypto.randomUUID(), name, input });
    const threadPrompts: string[] = [];
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      if (req.system.includes("coordinator of a shared project chat")) {
        const id = /\[(cmsg_[0-9A-Z]{26})\][^\n]*· NEW/.exec(req.prompt)?.[1];
        return id
          ? { text: "", toolCalls: [call("start_thread", { message_id: id, title: "Testler", instructions: "Run the tests." })] }
          : { text: "", toolCalls: [] };
      }
      threadPrompts.push(req.prompt);
      if (req.prompt.includes("(done, NEW result)")) {
        return { text: "", toolCalls: [call("reply", { text: "Testler geçti: 12 passed." })] };
      }
      return {
        text: "",
        toolCalls: [call("run_local_task", { prompt: "Run pnpm test" }), call("reply", { text: "Testleri bilgisayarında çalıştırıyorum." })],
      };
    });

    const user = await signUp();
    const { runner, token } = await pair(user);
    const runnerSide = await connectRunner(token);
    await until(async () => (await listRunners(user))[0]?.folders.length, "hello");
    const project = await createProject(user);
    await api(`/api/projects/${project.id}/workspace`, {
      method: "PUT",
      token: user,
      body: JSON.stringify({ runnerId: runner.id, path: "/Users/ismail/code/altair", cli: "claude" }),
    });

    const chat = (await api(`/api/projects/${project.id}/ws?token=${encodeURIComponent(user)}`, {
      headers: { upgrade: "websocket" },
    })).webSocket!;
    const events: ServerEvent[] = [];
    chat.addEventListener("message", (e) => {
      events.push(JSON.parse(e.data as string) as ServerEvent);
    });
    chat.accept();
    chat.send(JSON.stringify({ type: "message.send", body: "testleri çalıştır" }));

    const start = await until(
      () => runnerSide.frames.find((f): f is Extract<ServerToRunner, { type: "task.start" }> => f.type === "task.start"),
      "task.start",
    );
    expect(start).toMatchObject({ folder: "/Users/ismail/code/altair", cli: "claude", prompt: "Run pnpm test" });
    expect(threadPrompts[0]).toContain("/Users/ismail/code/altair on \"Laptop\"");

    const agent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const threadId = start.threadId;
    // While the task runs the thread shows as working, with the CLI's latest step.
    await until(async () => (await agent.getThread(threadId))?.status === "working" && events.some((e) => e.type === "agent.activity" && e.threadId === threadId && e.active), "working");
    runnerSide.send({ type: "task.progress", taskId: start.taskId, text: "Running pnpm test" });
    await until(() => events.some((e) => e.type === "agent.activity" && e.label === "Running pnpm test"), "progress label");

    runnerSide.send({ type: "task.done", taskId: start.taskId, ok: true, result: "12 passed" });
    const bodies = async () => ((await agent.getThreadContext(threadId))?.messages ?? []).map((m) => m.body);
    await until(async () => (await bodies()).includes("Testler geçti: 12 passed."), "answer with the result");
    expect(threadPrompts.at(-1)).toContain("Result:\n12 passed");
    await until(async () => (await agent.getThread(threadId))?.status === "review_ready", "idle again");

    chat.close();
    runnerSide.ws.close();
  });
});
