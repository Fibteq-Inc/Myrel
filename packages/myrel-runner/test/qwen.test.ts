import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToServer } from "@myrel/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpTurn, type AcpTurnOptions } from "../src/acp";
import { ADAPTERS, detectClis, type ParseState, qwenVersionArgs } from "../src/clis";
import { type RunnerConfig, SessionStore } from "../src/config";
import { TaskRunner } from "../src/tasks";

const qwen = ADAPTERS.qwen;

let home: string;
const savedPath = process.env.PATH;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "myrel-qwen-"));
  process.env.MYREL_RUNNER_HOME = home;
});
afterEach(() => {
  process.env.PATH = savedPath;
});

/** A stand-in `qwen` alone on PATH. */
async function fakeQwen(script: string) {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "qwen"), script);
  await chmod(join(bin, "qwen"), 0o755);
  process.env.PATH = `${bin}:/usr/bin:/bin`;
}

describe("Qwen Code arguments", () => {
  it("runs its ACP server with the other folders, and the permission mode and answer for each access", () => {
    expect(qwen.args({ access: "edit", resume: "s1" })).toEqual(["--acp"]);
    expect(qwen.args({ access: "edit", dirs: ["/docs"], extra: ["-x"] })).toEqual(["--acp", "--add-dir", "/docs", "-x"]);
    expect(qwen.acp!("read")).toMatchObject({ mode: "default", allow: false });
    // 1.x calls it acceptEdits, 0.x auto-edit.
    expect(qwen.acp!("edit")).toMatchObject({ mode: ["acceptEdits", "auto-edit"], allow: false });
    expect(qwen.acp!("auto")).toMatchObject({ mode: "auto", allow: false });
    expect(qwen.acp!("full")).toMatchObject({ mode: "yolo", allow: true });
    expect(qwen.acp!("edit").serverTools!("myrel")).toBe("mcp__myrel__");
    // No model list, so no model goes in the session.
    expect(qwen.acp!("edit", { model: "x" })).not.toHaveProperty("config");
    expect(qwen.models).toBeUndefined();
  });

  it("leaves out what 0.x would ask about, since a declined step ends its turn; nothing for 1.x", () => {
    const excluded = (version: string, access: "read" | "edit" | "auto" | "full") =>
      qwenVersionArgs(version, access).filter((a) => a !== "--exclude-tools");
    expect(excluded("0.27.4", "read")).toEqual(["run_shell_command", "monitor", "web_fetch", "write_file", "edit", "notebook_edit", "ask_user_question"]);
    expect(excluded("0.27.4", "edit")).toEqual(["run_shell_command", "monitor", "web_fetch", "ask_user_question"]);
    expect(qwenVersionArgs("0.27.4", "full")).toEqual(["--exclude-tools", "ask_user_question"]);
    expect(qwenVersionArgs("1.0.0-preview.2", "read")).toEqual([]);
    expect(qwenVersionArgs("2.1.0", "edit")).toEqual([]);
    // A version it cannot read is taken as 0.x: leaving tools out is the safe side.
    expect(qwenVersionArgs(null, "full")).toEqual(["--exclude-tools", "ask_user_question"]);
  });

  it("tells Qwen Code below full access that what needs approval is declined", () => {
    expect(qwen.input!("a", "full")).toBe("a");
    expect(qwen.input!("a", "read")).toMatch(/^a\n\n\(myrel-runner: this run may only read/);
    expect(qwen.input!("a", "edit")).toMatch(/shell commands, web pages .* are declined/);
    expect(qwen.input!("a", "auto")).toMatch(/safety check/);
  });

  it("is found when `qwen --version` prints a bare version", () => {
    expect(qwen.isMine!("0.27.4")).toBe(true);
    expect(qwen.isMine!("1.0.0-preview.2")).toBe(true);
    expect(qwen.isMine!("qwen: command from something else")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("Qwen Code on this computer", () => {
  it("gives the session Myrel's server and the connectors, the token only in their headers, and flags for its version", async () => {
    const connectors = [
      { transport: "http" as const, name: "linear", url: "https://myrel.test/api/agent-mcp/thr_1/c/linear" },
      { transport: "stdio" as const, name: "db", command: "npx", args: ["-y", "pg-mcp"], env: { DATABASE_URL: "postgres://x" } },
    ];
    const mcp = { url: "https://myrel.test/api/agent-mcp/thr_1", token: "t".repeat(32), dir: home, connectors, access: "edit" as const };
    const headers = [{ name: "Authorization", value: `Bearer ${"t".repeat(32)}` }];
    await fakeQwen('#!/bin/sh\necho "0.27.4"\n');
    const old = await qwen.agent({ ...mcp, skills: { plugin: join(home, "p"), dir: join(home, "p", "skills") } });
    expect(old.args).toEqual([
      ...["--exclude-tools", "run_shell_command", "--exclude-tools", "monitor", "--exclude-tools", "web_fetch", "--exclude-tools", "ask_user_question"],
      ...["--add-dir", join(home, "p", "skills")],
    ]);
    expect(old.mcpServers).toEqual([
      { type: "http", name: "myrel", url: "https://myrel.test/api/agent-mcp/thr_1", headers },
      { type: "http", name: "linear", url: connectors[0]!.url, headers },
      { name: "db", command: "npx", args: ["-y", "pg-mcp"], env: [{ name: "DATABASE_URL", value: "postgres://x" }] },
    ]);
    expect(JSON.stringify(old.args)).not.toContain("t".repeat(32));
    await fakeQwen('#!/bin/sh\necho "1.0.0-preview.2"\n');
    expect((await qwen.agent(mcp)).args).toEqual([]);
  });

  it("is found by `qwen --version`", async () => {
    await fakeQwen('#!/bin/sh\necho "0.27.4"\n');
    expect(await detectClis()).toEqual([{ id: "qwen", version: "0.27.4" }]);
  });

  it("runs a turn over ACP in the mode its version lists and keeps its session for the thread", async () => {
    // A stand-in ACP agent listing 0.x's modes: answers each request in order, records the calls, and exits when its stdin ends.
    await fakeQwen(`#!${process.execPath}
let buf = "";
const calls = [];
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const modes = { currentModeId: "auto", availableModes: ["plan", "default", "auto-edit", "auto", "yolo"].map((id) => ({ id, name: id })) };
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.method) calls.push(m.method + (m.params?.modeId ? ":" + m.params.modeId : ""));
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } });
    if (m.method === "session/new") send({ id: m.id, result: { sessionId: "qwen_abc", modes } });
    if (m.method === "session/set_mode") send({ id: m.id, result: {} });
    if (m.method === "session/prompt") {
      send({ method: "session/update", params: { sessionId: "qwen_abc", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.argv.slice(2).join(" ") + " | " + calls.join(", ") } } } });
      send({ id: m.id, result: { stopReason: "end_turn" } });
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
    await runner.start({ type: "task.start", taskId: "task_01JTEST0000000000000000000", threadId, folder, cli: "qwen", prompt: "hi" });
    await expect.poll(() => frames.find((f) => f.type === "task.done")).toBeTruthy();
    const done = frames.find((f) => f.type === "task.done") as { ok: boolean; result: string };
    expect(done.ok).toBe(true);
    expect(done.result).toBe("--acp | initialize, session/new, session/set_mode:auto-edit, session/prompt");
    expect(await sessions.get(threadId, "qwen")).toMatchObject({ id: "qwen_abc" });
  });
});

describe("ACP turn with Qwen Code's options", () => {
  function turn(opts: Partial<AcpTurnOptions> = {}) {
    const sent: Array<Record<string, unknown>> = [];
    const state: ParseState = {};
    const t = new AcpTurn({ write: (line) => sent.push(JSON.parse(line)), end: () => {} }, { cwd: "/w", prompt: "hi", mcpServers: [], allow: false, ...opts }, state);
    const last = () => sent.at(-1)!;
    const reply = (result: unknown) => t.receive(JSON.stringify({ jsonrpc: "2.0", id: last().id, result }));
    return { t, sent, state, last, reply };
  }
  const modes = (...ids: string[]) => ({ modes: { currentModeId: ids[0], availableModes: ids.map((id) => ({ id, name: id })) } });

  it("picks the first of several modes the session lists", () => {
    const { t, last, reply } = turn({ mode: ["acceptEdits", "auto-edit"] });
    t.start();
    reply({ protocolVersion: 1 });
    reply({ sessionId: "s1", ...modes("default", "acceptEdits", "auto", "dontAsk", "yolo") });
    expect(last()).toMatchObject({ method: "session/set_mode", params: { modeId: "acceptEdits" } });
  });

  it("looks at the modes a resumed session lists too", () => {
    const { t, last, reply } = turn({ mode: ["acceptEdits", "auto-edit"], resume: "s0" });
    t.start();
    reply({ protocolVersion: 1 });
    expect(last()).toMatchObject({ method: "session/resume", params: { sessionId: "s0" } });
    reply(modes("plan", "default", "auto-edit", "auto", "yolo"));
    expect(last()).toMatchObject({ method: "session/set_mode", params: { sessionId: "s0", modeId: "auto-edit" } });
  });

  it("tries the first mode when the session lists none", () => {
    const { t, last, reply } = turn({ mode: ["acceptEdits", "auto-edit"] });
    t.start();
    reply({ protocolVersion: 1 });
    reply({ sessionId: "s1" });
    expect(last()).toMatchObject({ method: "session/set_mode", params: { modeId: "acceptEdits" } });
  });

  it("takes all-zero usage as none, as Qwen Code 1.x reports it", () => {
    const { t, reply, state } = turn();
    t.start();
    reply({ protocolVersion: 1 });
    reply({ sessionId: "s1" });
    reply({ stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedReadTokens: 0 } });
    expect(state).toMatchObject({ failed: false });
    expect(state.usage).toBeUndefined();
  });

  it("allows the run's own MCP tools by the tool name in _meta, and declines the rest", () => {
    const options = [
      { optionId: "proceed_always_and_save", kind: "allow_always", name: "Always allow" },
      { optionId: "proceed_once", kind: "allow_once", name: "Allow" },
      { optionId: "cancel", kind: "reject_once", name: "Reject" },
    ];
    const { t, sent } = turn({ mcpServers: [{ type: "http", name: "myrel", url: "u", headers: [] }], serverTools: (s) => `mcp__${s}__` });
    const ask = (id: number, toolCall: Record<string, unknown>) =>
      t.receive(JSON.stringify({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId: "s1", options, toolCall: { toolCallId: "c", ...toolCall } } }));
    // As Qwen Code 1.x asks.
    ask(1, { title: "reply (myrel)", kind: "other", _meta: { qwen: { toolName: "mcp__myrel__reply" } } });
    expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 1, result: { outcome: { outcome: "selected", optionId: "proceed_once" } } });
    // As Qwen Code 0.x asks, through its tool_call bridge.
    ask(2, { title: '{"text":"hi"}', kind: "other", _meta: { toolName: "mcp__myrel__reply" } });
    expect(sent.at(-1)).toMatchObject({ id: 2, result: { outcome: { optionId: "proceed_once" } } });
    // The person's own servers and other steps are not the run's.
    ask(3, { title: "create_issue (github)", _meta: { qwen: { toolName: "mcp__github__create_issue" } } });
    expect(sent.at(-1)).toMatchObject({ id: 3, result: { outcome: { optionId: "cancel" } } });
    ask(4, { title: "echo hi > x.txt", kind: "execute", _meta: { qwen: { toolName: "Bash" } } });
    expect(sent.at(-1)).toMatchObject({ id: 4, result: { outcome: { optionId: "cancel" } } });
    ask(5, { title: "rm -rf x", _meta: null });
    expect(sent.at(-1)).toMatchObject({ id: 5, result: { outcome: { optionId: "cancel" } } });
  });
});
