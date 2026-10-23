import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToServer } from "@myrel/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpTurn, type AcpTurnOptions } from "../src/acp";
import { ADAPTERS, detectClis, type ParseState, parseKimiModels } from "../src/clis";
import { type RunnerConfig, SessionStore } from "../src/config";
import { TaskRunner } from "../src/tasks";

const kimi = ADAPTERS.kimi;

let home: string;
const savedPath = process.env.PATH;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "myrel-kimi-"));
  process.env.MYREL_RUNNER_HOME = home;
});
afterEach(() => {
  process.env.PATH = savedPath;
});

/** A stand-in `kimi` alone on PATH. */
async function fakeKimi(script: string) {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "kimi"), script);
  await chmod(join(bin, "kimi"), 0o755);
  process.env.PATH = `${bin}:/usr/bin:/bin`;
}

describe("Kimi Code arguments", () => {
  it("runs its ACP server, with the permission mode and answer for each access", () => {
    expect(kimi.args({ access: "edit", resume: "session_1" })).toEqual(["acp"]);
    expect(kimi.acp!("read")).toMatchObject({ mode: "plan", allow: false, config: [] });
    expect(kimi.acp!("edit")).toMatchObject({ mode: "default", allow: false });
    expect(kimi.acp!("auto")).toMatchObject({ mode: "default", allow: false });
    expect(kimi.acp!("full")).toMatchObject({ mode: "auto", allow: true });
    expect(kimi.acp!("edit").serverTools!("myrel")).toBe("mcp__myrel__");
  });

  it("sets the picked model and thinking level in the session", () => {
    expect(kimi.acp!("edit", { model: "kimi-code/kimi-for-coding", effort: "high" }).config).toEqual([
      { id: "model", value: "kimi-code/kimi-for-coding" },
      { id: "thinking", value: "high" },
    ]);
    expect(kimi.acp!("edit", { effort: "low" }).config).toEqual([{ id: "thinking", value: "low" }]);
  });

  it("tells Kimi Code below full access that what needs approval is declined", () => {
    expect(kimi.input!("a", "full")).toBe("a");
    expect(kimi.input!("a", "read")).toMatch(/^a\n\n\(myrel-runner: this run may only read/);
    expect(kimi.input!("a", "edit")).toMatch(/shell commands .* are declined/);
    expect(kimi.input!("a", "auto")).toBe(kimi.input!("a", "edit"));
  });

  it("gives the session Myrel's server and the connectors, the token only in their headers", async () => {
    const connectors = [
      { transport: "http" as const, name: "linear", url: "https://myrel.test/api/agent-mcp/thr_1/c/linear" },
      { transport: "stdio" as const, name: "db", command: "npx", args: ["-y", "pg-mcp"], env: { DATABASE_URL: "postgres://x" } },
    ];
    const agent = await kimi.agent({ url: "https://myrel.test/api/agent-mcp/thr_1", token: "t".repeat(32), dir: home, connectors });
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

  it("is told apart from the archived Python kimi-cli by its version", () => {
    expect(kimi.isMine!("2.3.1")).toBe(true);
    expect(kimi.isMine!("kimi, version 1.9.0")).toBe(false);
  });
});

describe("Kimi Code models", () => {
  it("lists its model aliases with the thinking levels each takes, never the providers' keys", () => {
    // `kimi provider list --json`, as Kimi Code 2.3.1 prints it.
    const json = JSON.stringify({
      providers: { "managed:kimi-code": { type: "kimi", apiKey: "sk-secret" } },
      models: {
        "kimi-code/kimi-for-coding": {
          provider: "managed:kimi-code",
          model: "kimi-for-coding",
          maxContextSize: 262144,
          capabilities: ["thinking", "tool_use"],
          displayName: "Kimi for Coding",
          supportEfforts: ["low", "medium", "high"],
          defaultEffort: "medium",
        },
        "k2-always": { provider: "p", model: "k2-thinking", capabilities: ["always_thinking"], supportEfforts: ["off", "high"] },
        plain: { provider: "p", model: "plain-model", maxContextSize: 64000, supportEfforts: ["high"] },
        "bad name;": { provider: "p", model: "x" },
      },
    });
    const models = parseKimiModels(json);
    expect(models).toEqual([
      { id: "kimi-code/kimi-for-coding", name: "Kimi for Coding", efforts: ["low", "medium", "high"] },
      { id: "k2-always", name: "k2-thinking", efforts: ["high"] },
      // Without the thinking capability Kimi Code offers no thinking levels.
      { id: "plain", name: "plain-model", efforts: [] },
    ]);
    expect(JSON.stringify(models)).not.toContain("sk-secret");
    expect(parseKimiModels(JSON.stringify({ providers: {}, models: {} }))).toBeUndefined();
    expect(parseKimiModels("not json")).toBeUndefined();
  });
});

describe("ACP turn with Kimi Code's options", () => {
  function turn(opts: Partial<AcpTurnOptions> = {}) {
    const sent: Array<Record<string, unknown>> = [];
    const state: ParseState = {};
    const t = new AcpTurn({ write: (line) => sent.push(JSON.parse(line)), end: () => {} }, { cwd: "/w", prompt: "hi", mcpServers: [], allow: false, ...opts }, state);
    const last = () => sent.at(-1)!;
    const reply = (result: unknown) => t.receive(JSON.stringify({ jsonrpc: "2.0", id: last().id, result }));
    const error = (message: string) => t.receive(JSON.stringify({ jsonrpc: "2.0", id: last().id, error: { code: -32602, message } }));
    return { t, sent, state, last, reply, error };
  }
  const modelOption = (value: string) => ({ configOptions: [{ type: "select", id: "model", category: "model", currentValue: value, options: [] }] });

  it("passes the other folders, sets the model and level, and skips one the agent refuses", () => {
    const config = [
      { id: "model", value: "other" },
      { id: "thinking", value: "max" },
    ];
    const { t, last, reply, error, state } = turn({ mode: "default", config, dirs: ["/docs"] });
    t.start();
    reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { additionalDirectories: {} } } });
    expect(last()).toMatchObject({ method: "session/new", params: { cwd: "/w", additionalDirectories: ["/docs"] } });
    reply({ sessionId: "s1", ...modelOption("stub") });
    expect(state.model).toBe("stub");
    expect(last()).toMatchObject({ method: "session/set_mode", params: { modeId: "default" } });
    reply({});
    expect(last()).toMatchObject({ method: "session/set_config_option", params: { sessionId: "s1", configId: "model", value: "other" } });
    reply(modelOption("other"));
    expect(state.model).toBe("other");
    expect(last()).toMatchObject({ method: "session/set_config_option", params: { configId: "thinking", value: "max" } });
    error("Invalid params: Unknown thinking value: max");
    expect(state.failed).toBeUndefined();
    expect(last()).toMatchObject({ method: "session/prompt", params: { sessionId: "s1" } });
  });

  it("leaves the folders out for an agent that does not take them", () => {
    const { t, last, reply } = turn({ dirs: ["/docs"] });
    t.start();
    reply({ protocolVersion: 1 });
    expect(last().params).not.toHaveProperty("additionalDirectories");
  });

  it("allows the run's own MCP tools below full access and declines the rest", () => {
    const options = [
      { optionId: "approve_once", kind: "allow_once", name: "Approve once" },
      { optionId: "approve_always", kind: "allow_always", name: "Approve for this session" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ];
    const { t, sent } = turn({ mcpServers: [{ type: "http", name: "myrel", url: "u", headers: [] }], serverTools: (s) => `mcp__${s}__` });
    const ask = (id: number, title: string) =>
      t.receive(JSON.stringify({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId: "s1", options, toolCall: { toolCallId: "c", title } } }));
    ask(1, "mcp__myrel__reply");
    expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 1, result: { outcome: { outcome: "selected", optionId: "approve_once" } } });
    // The person's own servers and other steps are not the run's.
    ask(2, "mcp__github__create_issue");
    expect(sent.at(-1)).toMatchObject({ id: 2, result: { outcome: { optionId: "reject" } } });
    ask(3, "Bash");
    expect(sent.at(-1)).toMatchObject({ id: 3, result: { outcome: { optionId: "reject" } } });
  });
});

describe.skipIf(process.platform === "win32")("Kimi Code on this computer", () => {
  it("is found only when `kimi --version` is Kimi Code's", async () => {
    await fakeKimi('#!/bin/sh\necho "2.3.1"\n');
    expect(await detectClis()).toEqual([{ id: "kimi", version: "2.3.1" }]);
    await fakeKimi('#!/bin/sh\necho "kimi, version 1.9.0"\n');
    expect(await detectClis()).toEqual([]);
  });

  it("reads its model list from the CLI", async () => {
    await fakeKimi(
      `#!/bin/sh\n[ "$1 $2 $3" = "provider list --json" ] && echo '{"providers":{},"models":{"k":{"model":"kimi-k2","capabilities":["thinking"],"supportEfforts":["low"]}}}'\n`,
    );
    expect(await kimi.models!()).toEqual([{ id: "k", name: "kimi-k2", efforts: ["low"] }]);
  });

  it("runs a turn over ACP with the task's model and keeps its session for the thread", async () => {
    // A stand-in ACP agent: answers each request in order, records the calls, and exits when its stdin ends.
    await fakeKimi(`#!${process.execPath}
let buf = "";
const calls = [];
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.method) calls.push(m.method + (m.params?.modeId ? ":" + m.params.modeId : "") + (m.params?.configId ? ":" + m.params.configId + "=" + m.params.value : ""));
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { additionalDirectories: {} } } } });
    if (m.method === "session/new") send({ id: m.id, result: { sessionId: "session_abc" } });
    if (m.method === "session/set_mode" || m.method === "session/set_config_option") send({ id: m.id, result: {} });
    if (m.method === "session/prompt") {
      send({ method: "session/update", params: { sessionId: "session_abc", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.argv.slice(2).join(" ") + " | " + calls.join(", ") } } } });
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
    const model = { model: "kimi-code/kimi-for-coding", effort: "high" };
    await runner.start({ type: "task.start", taskId: "task_01JTEST0000000000000000000", threadId, folder, cli: "kimi", prompt: "hi", model });
    await expect.poll(() => frames.find((f) => f.type === "task.done")).toBeTruthy();
    const done = frames.find((f) => f.type === "task.done") as { ok: boolean; result: string };
    expect(done.ok).toBe(true);
    expect(done.result).toBe(
      "acp | initialize, session/new, session/set_mode:default, session/set_config_option:model=kimi-code/kimi-for-coding, session/set_config_option:thinking=high, session/prompt",
    );
    expect(await sessions.get(threadId, "kimi")).toMatchObject({ id: "session_abc" });
  });
});
