import { type Project, RUNNER_PROTOCOL_VERSION, type ServerToRunner } from "@myrel/protocol";
import { exports } from "cloudflare:workers";
import { fakeModel } from "./fake-llm";

/**
 * Plays a thread's agent the way myrel-runner and the person's CLI would: a paired computer
 * with a shared folder connected to a project, whose CLI answers each turn by calling Myrel's
 * tools over the thread's MCP endpoint, then finishes the run.
 */

const BASE = "http://myrel.test";
export const FOLDER = "/Users/ismail/code/myrel";

export function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

export async function until<T>(fn: () => T | Promise<T>, what: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 200; i++) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export type TaskStart = Extract<ServerToRunner, { type: "task.start" }>;

/** One turn of the thread's agent, as its CLI sees it. */
export type Turn = {
  start: TaskStart;
  threadId: string;
  /** What the CLI got on stdin: Myrel's instructions and the thread. */
  prompt: string;
  /** Calls one of Myrel's tools, as the CLI would through MCP. */
  call(name: string, args?: unknown): Promise<{ isError: boolean; text: string }>;
};

/** How the fake CLI plays a turn. Returns its final message; `{ fail }` ends the run with that error. */
export type Play = (turn: Turn, index: number) => Promise<string | void | { fail: string }> | string | void | { fail: string };

/**
 * Plays each turn with the fake model (fake-llm.ts), as a CLI driven by that model would: it gets
 * the turn's prompt, and its tool calls go to Myrel's tools over MCP. Its text is the final message.
 */
export const modelAgent: Play = async (turn) => {
  const res = fakeModel()({ system: "", prompt: turn.prompt, turns: 1, last: turn.prompt });
  for (const c of res.toolCalls) await turn.call(c.name, c.input);
  return res.text;
};

/** Sends one JSON-RPC message to a thread's MCP endpoint. */
export function mcp(start: TaskStart, body: unknown, bearer = start.agent!.token) {
  return api(start.agent!.mcpPath, { method: "POST", headers: { authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
}

/** Fake computers' connections still open (see closeRunners). */
const openRunners = new Set<WebSocket>();

/**
 * Hangs up every fake computer agentProject connected (setup.ts does after each test). A socket
 * left open past its test file gets frames while vitest tears the file down, which fails the run
 * with an EnvironmentTeardownError even though every test passed.
 */
export function closeRunners() {
  for (const ws of openRunners) ws.close();
  openRunners.clear();
}

/**
 * A new project working in FOLDER on a fake computer of `token`'s user, with `play` as the
 * thread agent. `turns` lists every turn so far.
 */
export async function agentProject(token: string, play: Play, opts: { features?: string[] } = {}) {
  const codeRes = await api("/api/runners/pairing", { method: "POST", token });
  const { code } = (await codeRes.json()) as { code: string };
  const paired = await api("/api/runner/pair", {
    method: "POST",
    body: JSON.stringify({ code, name: "Laptop", hostname: "mbp", platform: "darwin" }),
  });
  const runner = (await paired.json()) as { runner: { id: string }; token: string };
  const res = await api("/api/runner/connect", { token: runner.token, headers: { upgrade: "websocket" } });
  const ws = res.webSocket!;
  openRunners.add(ws);
  const frames: ServerToRunner[] = [];
  const send = (frame: unknown) => ws.send(JSON.stringify(frame));
  const turns: Turn[] = [];
  ws.addEventListener("message", (e) => {
    const frame = JSON.parse(e.data as string) as ServerToRunner;
    frames.push(frame);
    if (frame.type !== "task.start" || !frame.agent) return;
    let rpc = 0;
    const turn: Turn = {
      start: frame,
      threadId: frame.threadId,
      prompt: frame.prompt,
      call: async (name, args = {}) => {
        const answer = (await (await mcp(frame, { jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } })).json()) as {
          result: { content: { text: string }[]; isError: boolean };
        };
        return { isError: answer.result.isError, text: answer.result.content[0]!.text };
      },
    };
    turns.push(turn);
    void (async () => {
      let out: Awaited<ReturnType<Play>>;
      try {
        out = await play(turn, turns.length - 1);
      } catch (err) {
        out = { fail: err instanceof Error ? err.message : String(err) };
      }
      if (typeof out === "object" && out !== null) send({ type: "task.done", taskId: frame.taskId, ok: false, result: out.fail });
      else send({ type: "task.done", taskId: frame.taskId, ok: true, result: out ?? "" });
    })();
  });
  ws.accept();
  send({
    type: "hello",
    protocol: RUNNER_PROTOCOL_VERSION,
    version: "0.5.0",
    hostname: "mbp",
    platform: "darwin",
    folders: [{ path: FOLDER, name: "myrel" }],
    clis: [{ id: "claude", version: "2.1.0" }],
    features: opts.features ?? ["folders", "cancel", "agent"],
    running: [],
  });
  await until(() => frames.some((f) => f.type === "welcome"), "welcome");

  const created = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Myrel" }) });
  const { project } = (await created.json()) as { project: Project };
  // The hello may still be on its way when the folder is picked.
  await until(async () => {
    const put = await api(`/api/projects/${project.id}/workspace`, {
      method: "PUT",
      token,
      body: JSON.stringify({ runnerId: runner.runner.id, path: FOLDER, cli: "claude" }),
    });
    return put.status === 200;
  }, "the project's local folder");
  return { project, runnerId: runner.runner.id, ws, frames, send, turns, close: () => ws.close() };
}

export async function signUp(name = "İsmail") {
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email: `u${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name }),
  });
  return res.headers.get("set-auth-token")!;
}
