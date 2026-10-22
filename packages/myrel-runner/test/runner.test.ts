import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToServer } from "@myrel/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { ADAPTERS, type ParseState } from "../src/clis";
import { loadConfig, type RunnerConfig, SessionStore, saveConfig, shareFolder, unshareFolder } from "../src/config";
import { RUNNER_VERSION } from "../src/runner";
import { sharedFolder, TaskRunner } from "../src/tasks";
import { isNewer } from "../src/update";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "myrel-runner-"));
  process.env.MYREL_RUNNER_HOME = home;
});

describe("config", () => {
  it("shares and unshares folders by absolute path", async () => {
    const config = await loadConfig();
    expect(config).toEqual({ folders: [], access: "edit" });
    expect(shareFolder(config, "/tmp/project/../project")).toBe(true);
    expect(shareFolder(config, "/tmp/project")).toBe(false);
    expect(config.folders).toEqual([{ path: "/tmp/project", name: "project" }]);
    await saveConfig(config);
    expect((await loadConfig()).folders).toHaveLength(1);
    expect(unshareFolder(config, "/tmp/project")).toBe(true);
  });
});

describe("env overrides", () => {
  it("uses MYREL_SERVER and MYREL_RUNNER_TOKEN without saving the token", async () => {
    await saveConfig({ folders: [], access: "edit", server: "https://saved.example", token: "art_saved" });
    process.env.MYREL_SERVER = "https://env.example";
    process.env.MYREL_RUNNER_TOKEN = "art_env";
    try {
      const config = await loadConfig();
      expect(config).toMatchObject({ server: "https://env.example", token: "art_env" });
      shareFolder(config, "/tmp/x");
      await saveConfig(config);
      delete process.env.MYREL_RUNNER_TOKEN;
      expect((await loadConfig()).token).toBe("art_saved");
    } finally {
      delete process.env.MYREL_SERVER;
      delete process.env.MYREL_RUNNER_TOKEN;
    }
  });
});

describe("sharedFolder", () => {
  it("accepts only folders the user shared, after resolving symlinks and ..", async () => {
    const shared = join(home, "code");
    await mkdir(join(shared, "sub"), { recursive: true });
    const config: RunnerConfig = { folders: [{ path: shared, name: "code" }], access: "edit" };
    expect(await sharedFolder(config, shared)).toBeTruthy();
    expect(await sharedFolder(config, join(shared, "sub", ".."))).toBeTruthy();
    expect(await sharedFolder(config, join(shared, "sub"))).toBeNull();
    expect(await sharedFolder(config, home)).toBeNull();
    expect(await sharedFolder(config, "/does/not/exist")).toBeNull();
  });
});

describe("CLI output parsing", () => {
  it("reads Claude Code stream-json", () => {
    const state: ParseState = {};
    const lines = [
      { type: "system", subtype: "init", session_id: "s-1" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm test" } }] } },
      { type: "result", subtype: "success", is_error: false, result: "All 12 tests pass.", session_id: "s-1" },
    ];
    lines.forEach((l, i) => {
      ADAPTERS.claude.line(JSON.stringify(l), state);
      if (i === 1) expect(state.progress).toBe("Bash: pnpm test");
    });
    expect(state).toMatchObject({ sessionId: "s-1", result: "All 12 tests pass.", failed: false });
    expect(ADAPTERS.claude.args({ access: "edit", resume: "s-1" })).toEqual(
      expect.arrayContaining(["--permission-mode", "acceptEdits", "--resume", "s-1"]),
    );
    // codex exec takes its own flags before the resume subcommand, then the session and the prompt.
    expect(ADAPTERS.codex.args({ access: "edit", resume: "s-2" }).slice(-3)).toEqual(["resume", "s-2", "-"]);
  });

  it("runs Claude Code in auto mode with auto access, asking Myrel about the rest; other CLIs stay at edit", () => {
    const args = ADAPTERS.claude.args({ access: "auto", asks: true });
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "auto", "--permission-prompt-tool", "mcp__myrel__approve_access"]));
    expect(ADAPTERS.codex.args({ access: "auto" })).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
    expect(ADAPTERS.gemini.args({ access: "auto" })).toEqual(expect.arrayContaining(["--approval-mode", "auto_edit"]));
  });

  it("starts Claude Code with only Myrel's MCP servers, its own tools loaded up front", async () => {
    const dir = await mkdtemp(join(tmpdir(), "myrel-agent-"));
    const agent = await ADAPTERS.claude.agent({ url: "https://myrel.test/mcp", token: "t".repeat(32), dir });
    // The person's own MCP servers would hold up the first model call (up to 30s for one that hangs).
    expect(agent.args).toEqual(expect.arrayContaining(["--strict-mcp-config"]));
    expect(agent.env).toMatchObject({ ENABLE_CLAUDEAI_MCP_SERVERS: "false", MCP_TIMEOUT: "10000" });
    const config = JSON.parse(await readFile(agent.args[agent.args.indexOf("--mcp-config") + 1]!, "utf8"));
    expect(config.mcpServers.myrel.alwaysLoad).toBe(true);
  });

  it("passes the project's other folders to each CLI", () => {
    expect(ADAPTERS.claude.args({ access: "full", dirs: ["/a"] })).toEqual(
      expect.arrayContaining(["--permission-mode", "bypassPermissions", "--add-dir", "/a"]),
    );
    expect(ADAPTERS.codex.args({ access: "edit", dirs: ["/a", "/b"] })).toEqual(
      expect.arrayContaining(["--add-dir", "/a", "--add-dir", "/b"]),
    );
    expect(ADAPTERS.gemini.args({ access: "edit", dirs: ["/a", "/b"] })).toEqual(
      expect.arrayContaining(["--include-directories", "/a,/b"]),
    );
  });

  it("reads Codex JSONL and Gemini JSON", () => {
    const codex: ParseState = {};
    ADAPTERS.codex.line(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "ls" } }), codex);
    expect(codex.progress).toBe("$ ls");
    ADAPTERS.codex.line(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done." } }), codex);
    expect(codex.result).toBe("Done.");

    const gemini: ParseState = {};
    ADAPTERS.gemini.end!(JSON.stringify({ response: "Merhaba" }), gemini);
    expect(gemini.result).toBe("Merhaba");
  });

  it("shows Codex's commands without their shell wrapper and its messages whole", () => {
    const codex: ParseState = {};
    const command = `/bin/zsh -lc "rg --files -g '"'!node_modules'"'"`;
    ADAPTERS.codex.line(JSON.stringify({ type: "item.started", item: { type: "command_execution", command } }), codex);
    expect(codex.progress).toBe("$ rg --files -g '!node_modules'");
    const text = `${"Kayıt adımı bir SQL prosedürünü çağırıyor. ".repeat(10)}\nİkinci satır.`;
    ADAPTERS.codex.line(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }), codex);
    expect(codex.progress).toBe(text.trim());
  });

  it("fails a Codex run only when its turn fails, not on an error it recovered from", () => {
    const recovered: ParseState = {};
    ADAPTERS.codex.line(JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }), recovered);
    ADAPTERS.codex.line(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Bitti." } }), recovered);
    ADAPTERS.codex.line(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }), recovered);
    expect(recovered.failed).toBeFalsy();
    expect(recovered.result).toBe("Bitti.");

    const failed: ParseState = {};
    ADAPTERS.codex.line(JSON.stringify({ type: "error", message: "stream disconnected" }), failed);
    ADAPTERS.codex.line(JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } }), failed);
    expect(failed.failed).toBe(true);
    expect(failed.result).toBe("stream disconnected");
  });
});

describe("CLI usage", () => {
  it("sums Claude Code's model calls once each, then takes the run's totals", () => {
    const state: ParseState = {};
    const call = (id: string, text: string) => ({
      type: "assistant",
      message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }, content: [{ type: "text", text }] },
    });
    // One call's parts arrive as separate events with the same usage.
    for (const l of [{ type: "system", subtype: "init", model: "claude-sonnet-5-5" }, call("m1", "a"), call("m1", "b"), call("m2", "c")]) {
      ADAPTERS.claude.line(JSON.stringify(l), state);
    }
    expect(state.usage).toEqual({ inputTokens: 200, outputTokens: 10 });
    expect(state.model).toBe("claude-sonnet-5-5");
    ADAPTERS.claude.line(JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 30, cache_read_input_tokens: 270, output_tokens: 15 } }), state);
    expect(state.usage).toEqual({ inputTokens: 300, outputTokens: 15 });
  });

  it("reads Codex's turn usage and Gemini's per-model stats", () => {
    const codex: ParseState = {};
    ADAPTERS.codex.line(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 40 } }), codex);
    expect(codex.usage).toEqual({ inputTokens: 500, outputTokens: 40 });

    const gemini: ParseState = {};
    ADAPTERS.gemini.end!(
      JSON.stringify({ response: "ok", stats: { models: { "gemini-3-pro": { tokens: { prompt: 700, candidates: 50, thoughts: 20 } } } } }),
      gemini,
    );
    expect(gemini).toMatchObject({ model: "gemini-3-pro", usage: { inputTokens: 700, outputTokens: 70 } });
  });
});

describe.skipIf(process.platform === "win32")("as the thread's agent", () => {
  const mcp = () => ({ url: "https://myrel.test/api/agent-mcp/thr_1", token: "t".repeat(32), dir: home });

  it("gives Codex the endpoint as config overrides and the token in its environment", async () => {
    const agent = await ADAPTERS.codex.agent(mcp());
    expect(agent).toEqual({
      args: ["-c", 'mcp_servers.myrel.url="https://myrel.test/api/agent-mcp/thr_1"', "-c", 'mcp_servers.myrel.bearer_token_env_var="MYREL_MCP_TOKEN"'],
      env: { MYREL_MCP_TOKEN: "t".repeat(32) },
    });
    // The prompt still comes last, on stdin.
    expect(ADAPTERS.codex.args({ access: "edit", extra: agent.args }).at(-1)).toBe("-");
  });

  it("gives Gemini CLI its own settings file, readable only by the user", async () => {
    const agent = await ADAPTERS.gemini.agent(mcp());
    const path = agent.env!.GEMINI_CLI_SYSTEM_SETTINGS_PATH!;
    expect(path).toBe(join(home, "settings.json"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mcpServers: { myrel: { httpUrl: mcp().url, headers: { Authorization: `Bearer ${"t".repeat(32)}` }, trust: true } },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("adds the thread's connectors and allows their tools", async () => {
    const connectors = [
      { transport: "http" as const, name: "linear", url: "https://myrel.test/api/agent-mcp/thr_1/c/linear" },
      { transport: "stdio" as const, name: "db", command: "npx", args: ["-y", "pg-mcp"], env: { DATABASE_URL: "postgres://x" } },
    ];
    const claude = await ADAPTERS.claude.agent({ ...mcp(), connectors });
    expect(claude.args.slice(-4)).toEqual(["--allowedTools", "mcp__myrel,mcp__linear,mcp__db", "--disallowedTools", "Bash(gh pr create:*)"]);
    const config = JSON.parse(await readFile(claude.args[1]!, "utf8"));
    expect(config.mcpServers.linear).toEqual({ type: "http", url: connectors[0]!.url, headers: { Authorization: `Bearer ${"t".repeat(32)}` } });
    expect(config.mcpServers.db).toEqual({ type: "stdio", command: "npx", args: ["-y", "pg-mcp"], env: { DATABASE_URL: "postgres://x" } });

    const codex = await ADAPTERS.codex.agent({ ...mcp(), connectors });
    expect(codex.args).toContain('mcp_servers.linear.url="https://myrel.test/api/agent-mcp/thr_1/c/linear"');
    expect(codex.args).toContain('mcp_servers.db.args=["-y","pg-mcp"]');
    expect(codex.args).toContain('mcp_servers.db.env={ DATABASE_URL = "postgres://x" }');
  });
});

describe.skipIf(process.platform === "win32")("TaskRunner", () => {
  /** A stand-in `claude` on PATH that echoes its prompt and cwd as stream-json. */
  async function fakeClaude(script: string) {
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), `#!/bin/sh\n${script}\n`);
    await chmod(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
  }

  async function run(config: RunnerConfig, folder: string, threadId = "thr_01JTEST0000000000000000000") {
    const frames: RunnerToServer[] = [];
    const runner = new TaskRunner({ config: () => config, sessions: new SessionStore() });
    runner.setSender((f) => frames.push(f));
    await runner.start({
      type: "task.start",
      taskId: "task_01JTEST0000000000000000000",
      threadId,
      folder,
      cli: "claude",
      prompt: "fix the bug",
    });
    return frames;
  }

  it("stops a task when the server asks", async () => {
    await fakeClaude("read prompt\nsleep 30");
    const folder = join(home, "proj");
    await mkdir(folder);
    const config: RunnerConfig = { folders: [{ path: folder, name: "proj" }], access: "edit" };
    const frames: RunnerToServer[] = [];
    const runner = new TaskRunner({ config: () => config, sessions: new SessionStore() });
    runner.setSender((f) => frames.push(f));
    const taskId = "task_01JTEST0000000000000000001";
    const done = runner.start({ type: "task.start", taskId, threadId: "thr_01JTEST0000000000000000000", folder, cli: "claude", prompt: "x" });
    for (let i = 0; i < 100 && !runner.runningIds().includes(taskId); i++) await new Promise((r) => setTimeout(r, 10));
    runner.cancel(taskId);
    await done;
    expect(frames.at(-1)).toEqual({ type: "task.done", taskId, ok: false, cancelled: true, result: "Stopped from Myrel." });
    expect(runner.runningIds()).toEqual([]);
  });

  it("runs the CLI in the shared folder with the prompt on stdin and reports the result", async () => {
    await fakeClaude(
      `read prompt
echo '{"type":"system","subtype":"init","session_id":"sess-42"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Working on it"}]}}'
printf '{"type":"result","subtype":"success","is_error":false,"result":"%s in %s"}\\n' "$prompt" "$(pwd)"`,
    );
    const folder = join(home, "proj");
    await mkdir(folder);
    const config: RunnerConfig = { folders: [{ path: folder, name: "proj" }], access: "edit" };

    const frames = await run(config, folder);
    expect(frames.at(-1)).toMatchObject({ type: "task.done", ok: true });
    expect((frames.at(-1) as { result: string }).result).toMatch(/^fix the bug in .*proj$/);
    // The thread's next task resumes the same CLI session.
    expect(await new SessionStore().get("thr_01JTEST0000000000000000000", "claude")).toEqual({ id: "sess-42", task: "task_01JTEST0000000000000000000" });
  });

  /** Starts an agent turn that may continue the session of turn `after`. */
  async function agentTurn(folder: string, after: string) {
    const frames: RunnerToServer[] = [];
    const runner = new TaskRunner({ config: () => ({ folders: [{ path: folder, name: "proj" }], access: "edit" }), sessions: new SessionStore() });
    runner.setSender((f) => frames.push(f));
    await runner.start({
      type: "task.start",
      taskId: "task_01JTEST0000000000000000002",
      threadId: "thr_01JTEST0000000000000000000",
      folder,
      cli: "claude",
      prompt: "whole thread",
      agent: { mcpPath: "/api/agent-mcp/thr_01JTEST0000000000000000000", token: "t".repeat(32), resume: { after, prompt: "only what is new" } },
    });
    return frames.at(-1) as { ok: boolean; result: string };
  }

  it("continues the last turn's session with only what is new", async () => {
    await fakeClaude(`read prompt
r=""; prev=""; for a in "$@"; do [ "$prev" = "--resume" ] && r="$a"; prev="$a"; done
printf '{"type":"result","subtype":"success","is_error":false,"result":"%s / %s"}\n' "$r" "$prompt"`);
    const folder = join(home, "proj");
    await mkdir(folder);
    const sessions = new SessionStore();
    await sessions.set("thr_01JTEST0000000000000000000", "claude", { id: "sess-1", task: "task_01JTEST0000000000000000001" });
    expect((await agentTurn(folder, "task_01JTEST0000000000000000001")).result).toBe("sess-1 / only what is new");
    // A session that did not see the last turn (it ran in the cloud, say) gets the whole thread.
    await sessions.set("thr_01JTEST0000000000000000000", "claude", { id: "sess-1", task: "task_01JTEST0000000000000000009" });
    expect((await agentTurn(folder, "task_01JTEST0000000000000000001")).result).toBe("sess-1 / whole thread");
  });

  it("starts a new session with the whole thread when the old one cannot be resumed", async () => {
    await fakeClaude(`read prompt
case "$*" in *--resume*) echo "No conversation found with session ID: sess-1" >&2; exit 1 ;; esac
printf '{"type":"result","subtype":"success","is_error":false,"result":"new / %s"}\n' "$prompt"`);
    const folder = join(home, "proj");
    await mkdir(folder);
    await new SessionStore().set("thr_01JTEST0000000000000000000", "claude", { id: "sess-1", task: "task_01JTEST0000000000000000001" });
    expect(await agentTurn(folder, "task_01JTEST0000000000000000001")).toMatchObject({ ok: true, result: "new / whole thread" });
  });

  it("connects the CLI to the thread's MCP endpoint when it runs as the thread's agent", async () => {
    // Prints the --mcp-config file it was given (which the runner deletes afterwards) as the result.
    await fakeClaude(
      `read prompt
cfg=""; prev=""; for a in "$@"; do [ "$prev" = "--mcp-config" ] && cfg="$a"; prev="$a"; done
printf '{"type":"result","subtype":"success","is_error":false,"result":%s}\n' "$(cat "$cfg" | sed 's/"/\\\\"/g; s/^/"/; s/$/"/')"
echo "args: $*" >&2`,
    );
    const folder = join(home, "proj3");
    await mkdir(folder);
    const config: RunnerConfig = { server: "https://myrel.test/", folders: [{ path: folder, name: "proj3" }], access: "edit" };
    const frames: RunnerToServer[] = [];
    const runner = new TaskRunner({ config: () => config, sessions: new SessionStore() });
    runner.setSender((f) => frames.push(f));
    await runner.start({
      type: "task.start",
      taskId: "task_01JTEST0000000000000000002",
      threadId: "thr_01JTEST0000000000000000009",
      folder,
      cli: "claude",
      prompt: "answer the person",
      agent: { mcpPath: "/api/agent-mcp/thr_01JTEST0000000000000000009", token: "t".repeat(32) },
    });
    const done = frames.at(-1) as { ok: boolean; result: string };
    expect(done.ok).toBe(true);
    expect(JSON.parse(done.result)).toEqual({
      mcpServers: {
        myrel: {
          type: "http",
          url: "https://myrel.test/api/agent-mcp/thr_01JTEST0000000000000000009",
          headers: { Authorization: `Bearer ${"t".repeat(32)}` },
          alwaysLoad: true,
        },
      },
    });
  });

  it("gives the agent the project's other shared folders and reports where it works", async () => {
    await fakeClaude(`read prompt
printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}\n' "$*"`);
    const folder = join(home, "main");
    const docs = join(home, "docs");
    const secret = join(home, "secret");
    await Promise.all([folder, docs, secret].map((d) => mkdir(d)));
    const config: RunnerConfig = {
      server: "https://myrel.test",
      folders: [
        { path: folder, name: "main" },
        { path: docs, name: "docs" },
      ],
      access: "full",
      worktrees: false,
    };
    const frames: RunnerToServer[] = [];
    const runner = new TaskRunner({ config: () => config, sessions: new SessionStore() });
    runner.setSender((f) => frames.push(f));
    const taskId = "task_01JTEST0000000000000000003";
    await runner.start({
      type: "task.start",
      taskId,
      threadId: "thr_01JTEST0000000000000000008",
      folder,
      folders: [docs, secret],
      cli: "claude",
      prompt: "x",
      agent: { mcpPath: "/api/agent-mcp/thr_01JTEST0000000000000000008", token: "t".repeat(32) },
    });
    const real = async (p: string) => (await import("node:fs/promises")).realpath(p);
    expect(frames[0]).toEqual({ type: "task.folders", taskId, folders: [await real(folder), await real(docs)] });
    const args = (frames.at(-1) as { result: string }).result;
    expect(args).toContain(`--add-dir ${await real(docs)}`);
    expect(args).not.toContain(secret);
    // Full access still asks about folders outside the project, through Myrel.
    expect(args).toContain("--permission-mode acceptEdits");
    expect(args).toContain("--permission-prompt-tool mcp__myrel__approve_access");
    expect(args).toMatch(/--allowedTools mcp__myrel,Bash,WebFetch,WebSearch/);
  });

  it("refuses folders that are not shared and reports a failing CLI", async () => {
    await fakeClaude(`echo "boom" >&2; exit 3`);
    const folder = join(home, "proj2");
    await mkdir(folder);
    const unshared = await run({ folders: [], access: "edit" }, folder);
    expect(unshared).toEqual([expect.objectContaining({ type: "task.done", ok: false })]);
    expect((unshared[0] as { result: string }).result).toContain("not shared");

    const failed = await run({ folders: [{ path: folder, name: "proj2" }], access: "edit" }, folder);
    expect(failed.at(-1)).toMatchObject({ type: "task.done", ok: false });
    expect((failed.at(-1) as { result: string }).result).toContain("boom");
  });
});

describe("package", () => {
  it("reports the version it is published as", async () => {
    const versions = await Promise.all(
      ["../package.json", "../../myrel-runner-alias/package.json"].map(async (p) => {
        const pkg = JSON.parse(await readFile(new URL(p, import.meta.url), "utf8")) as { version: string };
        return pkg.version;
      }),
    );
    expect(versions).toEqual([RUNNER_VERSION, RUNNER_VERSION]);
  });
});

describe("update", () => {
  it("compares versions", () => {
    expect(isNewer("0.3.0", "0.2.9")).toBe(true);
    expect(isNewer("0.2.10", "0.2.9")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.2.2", "0.2.2")).toBe(false);
    expect(isNewer("0.2.1", "0.2.2")).toBe(false);
    expect(isNewer("0.3.0-beta.1", "0.2.2")).toBe(true);
  });
});
