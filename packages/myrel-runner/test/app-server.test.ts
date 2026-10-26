import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToServer } from "@myrel/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppServerTurn, type AppServerTurnOptions, appServerLimits, approveAccess } from "../src/app-server";
import { ADAPTERS, hasAppServer, type ParseState } from "../src/clis";
import { type RunnerConfig, SessionStore } from "../src/config";
import { TaskRunner } from "../src/tasks";

let home: string;
const savedPath = process.env.PATH;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "myrel-codex-"));
  process.env.MYREL_RUNNER_HOME = home;
});
afterEach(() => {
  process.env.PATH = savedPath;
  delete process.env.MYREL_CODEX_EXEC;
});

type Sent = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };

/** An app server turn whose messages to Codex are collected, and lines from Codex fed by hand. */
function turn(opts: Partial<AppServerTurnOptions> = {}) {
  const sent: Sent[] = [];
  let ended = false;
  const state: ParseState = {};
  const t = new AppServerTurn(
    { write: (line) => sent.push(JSON.parse(line) as Sent), end: () => (ended = true) },
    { cwd: "/proj", prompt: "fix it", sandbox: "workspace-write", approvalPolicy: "on-request", clientVersion: "1.0.0", ...opts },
    state,
  );
  const feed = (m: object) => t.receive(JSON.stringify(m));
  const answer = (method: string, result: unknown) => {
    const request = sent.filter((m) => m.method === method).at(-1)!;
    feed({ id: request.id, result });
  };
  /** Through initialize, the session and the turn's start. */
  const open = (thread = "thr-1") => {
    t.start();
    answer("initialize", { userAgent: "codex" });
    answer(opts.resume ? "thread/resume" : "thread/start", { thread: { id: thread }, model: "gpt-6" });
    answer("turn/start", { turn: { id: "turn-1", status: "inProgress" } });
  };
  return { t, sent, state, feed, answer, open, ended: () => ended };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Codex app server turn", () => {
  it("starts a session with the sandbox and approval policy, then the turn with the prompt and effort", () => {
    const { sent, open, state } = turn({ model: { model: "gpt-6", effort: "high" }, config: { "sandbox_workspace_write.writable_roots": ["/other"] } });
    open();
    expect(sent.map((m) => m.method)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(sent[2]!.params).toEqual({
      cwd: "/proj",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      model: "gpt-6",
      config: { "sandbox_workspace_write.writable_roots": ["/other"] },
    });
    expect(sent[3]!.params).toEqual({ threadId: "thr-1", input: [{ type: "text", text: "fix it" }], effort: "high" });
    expect(state).toMatchObject({ sessionId: "thr-1", model: "gpt-6" });
  });

  it("resumes the session it is given", () => {
    const { sent, open } = turn({ resume: "thr-9" });
    open("thr-9");
    expect(sent[2]).toMatchObject({ method: "thread/resume", params: { threadId: "thr-9", cwd: "/proj" } });
  });

  it("fails before any output when the session cannot be resumed, so the runner starts a new one", () => {
    const { t, sent, feed, state, ended } = turn({ resume: "gone" });
    t.start();
    feed({ id: sent[0]!.id, result: {} });
    feed({ id: sent.find((m) => m.method === "thread/resume")!.id, error: { code: -32600, message: "no rollout found" } });
    expect(state).toEqual({ failed: true, result: "no rollout found" });
    expect(ended()).toBe(true);
  });

  it("reports steps, sums each model call's usage, and ends with the last message once the turn completes", () => {
    const { feed, open, state, ended } = turn();
    open();
    const item = (method: string, item: object) => feed({ method, params: { threadId: "thr-1", turnId: "turn-1", item } });
    item("item/started", { type: "commandExecution", id: "e1", command: "/bin/bash -lc 'ls -a'", commandActions: [{ type: "unknown", command: "ls -a" }] });
    expect(state.progress).toBe("$ ls -a");
    item("item/started", { type: "fileChange", id: "f1", changes: [{ path: "/proj/a.ts" }] });
    expect(state.progress).toBe("Edit /proj/a.ts");
    const usage = (input: number, output: number, totalInput: number) =>
      feed({
        method: "thread/tokenUsage/updated",
        params: { threadId: "thr-1", turnId: "turn-1", tokenUsage: { last: { inputTokens: input, outputTokens: output }, total: { inputTokens: totalInput, outputTokens: 0 } } },
      });
    usage(100, 10, 5000);
    usage(200, 20, 5200);
    expect(state.usage).toEqual({ inputTokens: 300, outputTokens: 30 });
    item("item/completed", { type: "agentMessage", id: "m1", text: "Bitti.", phase: "final_answer" });
    feed({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1793603978 }, secondary: null } } });
    expect(state.limits?.windows).toEqual([{ kind: "weekly", usedPercent: 4, resetsAt: new Date(1793603978 * 1000).toISOString() }]);
    expect(ended()).toBe(false);
    feed({ method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status: "completed", error: null } } });
    expect(state).toMatchObject({ result: "Bitti.", failed: false });
    expect(ended()).toBe(true);
  });

  it("fails a failed turn with its error, but not one that recovered from an error", () => {
    const a = turn();
    a.open();
    a.feed({ method: "error", params: { threadId: "thr-1", turnId: "turn-1", error: { message: "Reconnecting... 1/5" }, willRetry: true } });
    a.feed({ method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } } });
    expect(a.state.failed).toBe(false);
    const b = turn();
    b.open();
    b.feed({ method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status: "failed", error: { message: "usage limit reached" } } } });
    expect(b.state).toMatchObject({ failed: true, result: "usage limit reached" });
  });

  it("asks the person about a command its sandbox does not allow, and answers Codex with their decision", async () => {
    const asked: Array<[string, Record<string, unknown>]> = [];
    let allow = true;
    const { sent, feed, open } = turn({ ask: async (tool, input) => (asked.push([tool, input]), allow) });
    open();
    const request = (id: number) =>
      feed({
        id,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thr-1", turnId: "turn-1", itemId: "e1", command: "/bin/bash -lc 'git push'", reason: "Push needs the network", commandActions: [{ type: "unknown", command: "git push" }] },
      });
    // The app server's own request ids start at 0.
    request(0);
    await settle();
    expect(asked).toEqual([["Bash", { command: "git push", description: "Push needs the network" }]]);
    expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 0, result: { decision: "accept" } });
    allow = false;
    request(1);
    await settle();
    expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 1, result: { decision: "decline" } });
  });

  it("asks about each file of a change outside the workspace", async () => {
    const asked: string[] = [];
    const { sent, feed, open } = turn({ ask: async (_tool, input) => (asked.push(String(input.file_path)), true) });
    open();
    feed({ method: "item/started", params: { threadId: "thr-1", item: { type: "fileChange", id: "f1", changes: [{ path: "/home/a/notes.md" }] } } });
    feed({ id: 3, method: "item/fileChange/requestApproval", params: { threadId: "thr-1", turnId: "turn-1", itemId: "f1" } });
    await settle();
    expect(asked).toEqual(["/home/a/notes.md"]);
    expect(sent.at(-1)).toMatchObject({ id: 3, result: { decision: "accept" } });
  });

  it("declines what needs approval when nobody can be asked, and refuses requests it does not offer", async () => {
    const { sent, feed, open } = turn();
    open();
    feed({ id: 5, method: "item/commandExecution/requestApproval", params: { threadId: "thr-1", command: "rm -rf /tmp/x" } });
    feed({ id: 6, method: "item/tool/requestUserInput", params: {} });
    await settle();
    expect(sent.find((m) => m.id === 5 && m.result)).toMatchObject({ result: { decision: "decline" } });
    expect(sent.find((m) => m.id === 6)).toMatchObject({ error: { code: -32601 } });
  });

  it("interrupts the running turn, also when asked before the turn had an id", () => {
    const a = turn();
    a.open();
    expect(a.t.interrupt()).toBe(true);
    expect(a.sent.at(-1)).toMatchObject({ method: "turn/interrupt", params: { threadId: "thr-1", turnId: "turn-1" } });
    a.feed({ method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status: "interrupted" } } });
    expect(a.state).toMatchObject({ failed: true, result: "Codex stopped." });
    expect(a.ended()).toBe(true);
    expect(a.t.interrupt()).toBe(false);

    const b = turn();
    b.t.start();
    b.answer("initialize", {});
    b.answer("thread/start", { thread: { id: "thr-2" } });
    b.t.interrupt();
    expect(b.sent.some((m) => m.method === "turn/interrupt")).toBe(false);
    b.answer("turn/start", { turn: { id: "turn-2" } });
    expect(b.sent.at(-1)).toMatchObject({ method: "turn/interrupt", params: { threadId: "thr-2", turnId: "turn-2" } });
  });

  it("hands a message to the running turn, and says when it could not", async () => {
    const a = turn();
    a.t.start();
    // No turn yet to take it.
    expect(await a.t.steer("dur")).toBe(false);
    a.answer("initialize", {});
    a.answer("thread/start", { thread: { id: "thr-1" } });
    a.answer("turn/start", { turn: { id: "turn-1" } });
    const taken = a.t.steer("README'yi de güncelle");
    expect(a.sent.at(-1)).toMatchObject({
      method: "turn/steer",
      params: { threadId: "thr-1", expectedTurnId: "turn-1", input: [{ type: "text", text: "README'yi de güncelle" }] },
    });
    a.answer("turn/steer", { turnId: "turn-1" });
    expect(await taken).toBe(true);
    const refused = a.t.steer("x");
    a.feed({ id: a.sent.at(-1)!.id, error: { code: -32600, message: "no active turn" } });
    expect(await refused).toBe(false);
    // Still unanswered when the turn ends: not taken.
    const late = a.t.steer("y");
    a.feed({ method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } } });
    expect(await late).toBe(false);
    expect(a.state.failed).toBe(false);
    expect(await a.t.steer("z")).toBe(false);
  });

  it("maps the app server's rate limits like the session files' ones", () => {
    expect(appServerLimits({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 4102444800 } })).toMatchObject({
      status: "limited",
      windows: [{ kind: "session", usedPercent: 100 }],
    });
    expect(appServerLimits(null)).toBeUndefined();
  });
});

describe("Codex as its app server", () => {
  it("runs the app server's sandbox for each access, asking only where the person can answer", () => {
    const opts = (access: "read" | "edit" | "auto" | "full", asks = true) => ADAPTERS.codex.appServer!({ access, dirs: [], asks });
    expect(opts("read")).toEqual({ sandbox: "read-only", approvalPolicy: "never" });
    expect(opts("edit")).toEqual({ sandbox: "workspace-write", approvalPolicy: "on-request" });
    expect(opts("auto")).toEqual({ sandbox: "workspace-write", approvalPolicy: "on-request" });
    expect(opts("edit", false)).toEqual({ sandbox: "workspace-write", approvalPolicy: "never" });
    expect(opts("full")).toEqual({ sandbox: "danger-full-access", approvalPolicy: "never" });
    // Other folders go in the session config, never through a shell.
    expect(ADAPTERS.codex.appServer!({ access: "edit", dirs: ["/a b"], asks: true }).config).toEqual({ "sandbox_workspace_write.writable_roots": ["/a b"] });
  });

  it("asks Myrel's approve_access tool with the turn's token and reads its answer", async () => {
    const calls: Array<{ auth?: string; body: { method: string; params: { name: string; arguments: unknown } } }> = [];
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        calls.push({ auth: req.headers.authorization, body: parsed });
        const behavior = parsed.params.arguments.input.command === "git push" ? "allow" : "deny";
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { content: [{ type: "text", text: JSON.stringify({ behavior }) }] } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-mcp/thr_1`;
      const ask = approveAccess(url, "tok");
      expect(await ask("Bash", { command: "git push" })).toBe(true);
      expect(await ask("Bash", { command: "rm -rf ~" })).toBe(false);
      expect(calls[0]).toEqual({
        auth: "Bearer tok",
        body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "approve_access", arguments: { tool_name: "Bash", input: { command: "git push" } } } },
      });
      // Nobody there: declined, not thrown.
      expect(await approveAccess("http://127.0.0.1:9/x", "tok")("Bash", { command: "ls" })).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe.skipIf(process.platform === "win32")("TaskRunner with Codex's app server", () => {
  /** A stand-in `codex` alone on PATH: `--version`, `app-server --help`, and an app server that runs one turn. */
  async function fakeCodex(appServer = true) {
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    const script = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 9.${appServer ? 1 : 0}.0"); process.exit(0); }
if (args[0] === "app-server" && args[1] === "--help") { if (${appServer}) console.log("--listen <URL>"); process.exit(${appServer ? 0 : 2}); }
if (args[0] !== "app-server") { console.log(JSON.stringify({ type: "thread.started", thread_id: "exec-1" })); console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "from exec" } })); console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })); process.exit(0); }
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c; const lines = buf.split("\\n"); buf = lines.pop();
  for (const l of lines) {
    const m = JSON.parse(l);
    if (m.method === "initialize") send({ id: m.id, result: {} });
    if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: "thr-app" }, model: "gpt-6" } });
    if (m.method === "turn/start") {
      send({ id: m.id, result: { turn: { id: "turn-1" } } });
      send({ method: "item/completed", params: { threadId: "thr-app", item: { type: "agentMessage", text: m.params.input[0].text + " in " + process.cwd() + " (" + JSON.stringify(args) + ")" } } });
      send({ method: "thread/tokenUsage/updated", params: { threadId: "thr-app", tokenUsage: { last: { inputTokens: 7, outputTokens: 3 } } } });
      send({ method: "turn/completed", params: { threadId: "thr-app", turn: { id: "turn-1", status: "completed" } } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;
    await writeFile(join(bin, "codex"), script);
    await chmod(join(bin, "codex"), 0o755);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
  }

  async function run(folder: string) {
    const frames: RunnerToServer[] = [];
    const config: RunnerConfig = { folders: [{ path: folder, name: "proj" }], access: "edit", worktrees: false };
    const runner = new TaskRunner({ config: () => config, sessions: new SessionStore(), version: "9.9.9" });
    runner.setSender((f) => frames.push(f));
    await runner.start({ type: "task.start", taskId: "task_01JTEST0000000000000000009", threadId: "thr_01JTEST0000000000000000000", folder, cli: "codex", prompt: "fix the bug" });
    return frames.at(-1) as { type: string; ok: boolean; result: string; usage?: unknown };
  }

  it("runs a turn through the app server and keeps its session for the next one", async () => {
    await fakeCodex();
    const folder = join(home, "proj");
    await mkdir(folder);
    const done = await run(folder);
    expect(done).toMatchObject({ type: "task.done", ok: true, usage: { inputTokens: 7, outputTokens: 3, model: "gpt-6" } });
    expect(done.result).toMatch(/^fix the bug in .*proj \(\["app-server"\]\)$/);
    expect(await new SessionStore().get("thr_01JTEST0000000000000000000", "codex")).toMatchObject({ id: "thr-app" });
  });

  it("says a task it has no app server turn for took no message", async () => {
    const runner = new TaskRunner({ config: () => ({ folders: [], access: "edit" }), sessions: new SessionStore() });
    expect(await runner.steer("task_01JTEST0000000000000000009", "hi")).toBe(false);
  });

  it("keeps codex exec where Codex has no app server, or when MYREL_CODEX_EXEC=1", async () => {
    await fakeCodex(false);
    expect(await hasAppServer("codex")).toBe(false);
    const folder = join(home, "proj");
    await mkdir(folder);
    expect((await run(folder)).result).toBe("from exec");
    await fakeCodex(true);
    process.env.MYREL_CODEX_EXEC = "1";
    expect(await hasAppServer("codex")).toBe(false);
  });
});
