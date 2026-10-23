import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToServer } from "@myrel/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpTurn, type AcpTurnOptions } from "../src/acp";
import { ADAPTERS, detectClis, type ParseState } from "../src/clis";
import { type RunnerConfig, SessionStore } from "../src/config";
import { TaskRunner } from "../src/tasks";

const hermes = ADAPTERS.hermes;

let home: string;
const savedPath = process.env.PATH;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "myrel-hermes-"));
  process.env.MYREL_RUNNER_HOME = home;
});
afterEach(() => {
  process.env.PATH = savedPath;
});

/** A stand-in `hermes` alone on PATH. */
async function fakeHermes(script: string) {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "hermes"), script);
  await chmod(join(bin, "hermes"), 0o755);
  process.env.PATH = `${bin}:/usr/bin:/bin`;
}

describe("Hermes arguments", () => {
  it("runs its ACP server, with the edit mode and permission answer for each access", () => {
    expect(hermes.args({ access: "edit", resume: "local-1" })).toEqual(["acp"]);
    expect(hermes.acp!("read")).toEqual({ mode: "default", allow: false });
    expect(hermes.acp!("edit")).toEqual({ mode: "accept_edits", allow: false });
    expect(hermes.acp!("auto")).toEqual({ mode: "accept_edits", allow: false });
    expect(hermes.acp!("full")).toEqual({ mode: "dont_ask", allow: true });
  });

  it("tells Hermes below full access that what needs approval is declined", () => {
    expect(hermes.input!("a", "full")).toBe("a");
    expect(hermes.input!("a", "edit")).toMatch(/^a\n\n\(myrel-runner: steps that need approval/);
    expect(hermes.input!("a", "read")).toMatch(/may only read/);
  });

  it("gives the session Myrel's server and the connectors, the token only in their headers", async () => {
    const connectors = [
      { transport: "http" as const, name: "linear", url: "https://myrel.test/api/agent-mcp/thr_1/c/linear" },
      { transport: "stdio" as const, name: "db", command: "npx", args: ["-y", "pg-mcp"], env: { DATABASE_URL: "postgres://x" } },
    ];
    const agent = await hermes.agent({ url: "https://myrel.test/api/agent-mcp/thr_1", token: "t".repeat(32), dir: home, connectors });
    const headers = [{ name: "Authorization", value: `Bearer ${"t".repeat(32)}` }];
    expect(agent).toEqual({
      args: [],
      mcpServers: [
        { type: "http", name: "myrel", url: "https://myrel.test/api/agent-mcp/thr_1", headers },
        { type: "http", name: "linear", url: connectors[0]!.url, headers },
        { name: "db", command: "npx", args: ["-y", "pg-mcp"], env: [{ name: "DATABASE_URL", value: "postgres://x" }] },
      ],
    });
  });
});

describe("ACP turn", () => {
  /** A turn whose sent messages are collected; `reply` answers the last request. */
  function turn(opts: Partial<AcpTurnOptions> = {}) {
    const sent: Array<Record<string, unknown>> = [];
    let ended = false;
    const state: ParseState = {};
    const t = new AcpTurn(
      { write: (line) => sent.push(JSON.parse(line)), end: () => (ended = true) },
      { cwd: "/w", prompt: "hi", mcpServers: [], allow: false, ...opts },
      state,
    );
    const last = () => sent.at(-1)!;
    const reply = (result: unknown) => t.receive(JSON.stringify({ jsonrpc: "2.0", id: last().id, result }));
    const update = (update: unknown) => t.receive(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update } }));
    return { t, sent, state, last, reply, update, ended: () => ended };
  }

  it("opens a session, sets the mode, prompts and reads the answer", () => {
    const { t, last, reply, update, state, ended } = turn({ mode: "accept_edits", mcpServers: [{ type: "http", name: "myrel", url: "u", headers: [] }] });
    t.start();
    expect(last()).toMatchObject({ method: "initialize", params: { protocolVersion: 1, clientCapabilities: { terminal: false } } });
    reply({ protocolVersion: 1 });
    expect(last()).toMatchObject({ method: "session/new", params: { cwd: "/w", mcpServers: [{ name: "myrel" }] } });
    reply({ sessionId: "s1" });
    expect(state.sessionId).toBe("s1");
    expect(last()).toMatchObject({ method: "session/set_mode", params: { sessionId: "s1", modeId: "accept_edits" } });
    reply({});
    expect(last()).toMatchObject({ method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Önce bakıyorum." } });
    update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "terminal: ls", kind: "execute" });
    expect(state.progress).toBe("terminal: ls");
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\nBit" } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ti." } });
    expect(ended()).toBe(false);
    reply({ stopReason: "end_turn", usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220 } });
    // The answer is the text after the last step.
    expect(state).toMatchObject({ result: "Bitti.", failed: false, usage: { inputTokens: 200, outputTokens: 20 } });
    expect(ended()).toBe(true);
  });

  it("continues a session without taking its replayed history as this turn", () => {
    const { t, last, reply, update, state } = turn({ resume: "s0" });
    t.start();
    reply({});
    expect(last()).toMatchObject({ method: "session/resume", params: { sessionId: "s0", cwd: "/w" } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "eski cevap" } });
    reply({});
    expect(state.progress).toBeUndefined();
    expect(last()).toMatchObject({ method: "session/prompt", params: { sessionId: "s0" } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "yeni" } });
    reply({ stopReason: "end_turn" });
    expect(state).toMatchObject({ sessionId: "s0", result: "yeni" });
  });

  it("answers permission requests by the run's access and refuses what it does not offer", () => {
    const options = [
      { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
      { optionId: "deny", kind: "reject_once", name: "Deny" },
    ];
    for (const allow of [false, true]) {
      const { t, sent } = turn({ allow });
      t.receive(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { sessionId: "s1", options } }));
      expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: allow ? "allow_once" : "deny" } } });
      t.receive(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "fs/read_text_file", params: { path: "/etc/passwd" } }));
      expect(sent.at(-1)).toMatchObject({ id: 8, error: { code: -32601 } });
    }
  });

  it("fails the turn with the agent's error, before any output", () => {
    const { t, reply, last, state, ended } = turn({ resume: "gone" });
    t.start();
    reply({});
    t.receive(JSON.stringify({ jsonrpc: "2.0", id: last().id, error: { code: -32603, message: "Internal error" } }));
    expect(state).toMatchObject({ failed: true, result: "Internal error" });
    // No progress or usage: the runner then starts a new session with the whole thread.
    expect(state.progress).toBeUndefined();
    expect(ended()).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("Hermes on this computer", () => {
  it("is found only when `hermes --version` is Hermes Agent", async () => {
    await fakeHermes('#!/bin/sh\necho "Hermes Agent v0.22.5 (2026.9.24)"\necho "Install directory: /x"\n');
    expect(await detectClis()).toEqual([{ id: "hermes", version: "Hermes Agent v0.22.5 (2026.9.24)" }]);
    // The React Native JavaScript engine has a `hermes` too.
    await fakeHermes('#!/bin/sh\necho "Hermes JavaScript compiler and Virtual Machine."\n');
    expect(await detectClis()).toEqual([]);
  });

  it("runs a turn over ACP and keeps its session for the thread", async () => {
    // A stand-in ACP agent: answers each request in order and exits when its stdin ends.
    await fakeHermes(`#!${process.execPath}
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1 } });
    if (m.method === "session/new") send({ id: m.id, result: { sessionId: "local-abc" } });
    if (m.method === "session/set_mode") send({ id: m.id, result: {} });
    if (m.method === "session/prompt") {
      send({ method: "session/update", params: { sessionId: "local-abc", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cwd " + process.cwd() + ", servers " + JSON.stringify(process.argv.slice(2)) } } } });
      send({ id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`);
    const folder = join(home, "code");
    await mkdir(folder, { recursive: true });
    const config: RunnerConfig = { folders: [{ path: folder, name: "code" }], access: "edit", worktrees: false };
    const sessions = new SessionStore();
    const frames: RunnerToServer[] = [];
    const runner = new TaskRunner({ config: () => config, sessions });
    runner.setSender((f) => frames.push(f));
    const threadId = "thr_01JTEST0000000000000000000";
    await runner.start({ type: "task.start", taskId: "task_01JTEST0000000000000000000", threadId, folder, cli: "hermes", prompt: "hi" });
    await expect.poll(() => frames.find((f) => f.type === "task.done")).toBeTruthy();
    const done = frames.find((f) => f.type === "task.done")!;
    expect(done).toMatchObject({ ok: true, usage: { inputTokens: 5, outputTokens: 2 } });
    expect((done as { result: string }).result).toMatch(/^cwd .*code, servers \["acp"\]$/);
    expect(await sessions.get(threadId, "hermes")).toMatchObject({ id: "local-abc" });
  });
});
