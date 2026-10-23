import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADAPTERS, cursorConfig, detectClis, type ParseState } from "../src/clis";

const cursor = ADAPTERS.cursor;

let home: string;
const saved = { PATH: process.env.PATH, CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR };
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "myrel-cursor-"));
  process.env.CURSOR_CONFIG_DIR = join(home, "own");
});
afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.CURSOR_CONFIG_DIR === undefined) delete process.env.CURSOR_CONFIG_DIR;
  else process.env.CURSOR_CONFIG_DIR = saved.CURSOR_CONFIG_DIR;
});

describe("Cursor CLI arguments", () => {
  it("runs headless with JSON events, the prompt on stdin", () => {
    const base = ["-p", "--output-format", "stream-json", "--trust"];
    // Ask mode reads and answers; plan mode would leave out Myrel's tools.
    expect(cursor.args({ access: "read" })).toEqual([...base, "--mode", "ask"]);
    // Edits and commands in its sandbox: the workspace, no network.
    expect(cursor.args({ access: "edit" })).toEqual([...base, "--sandbox", "enabled"]);
    expect(cursor.args({ access: "auto" })).toEqual([...base, "--sandbox", "enabled"]);
    // --force would take commands out of the sandbox, so only full access uses it.
    expect(cursor.args({ access: "full" })).toEqual([...base, "--force", "--sandbox", "disabled"]);
    expect(cursor.args({ access: "edit", dirs: ["/code/lib"], resume: "chat-1", extra: ["--approve-mcps"] })).toEqual([
      ...base,
      "--sandbox",
      "enabled",
      "--add-dir",
      "/code/lib",
      "--resume",
      "chat-1",
      "--approve-mcps",
    ]);
    expect(cursor.input).toBeUndefined();
  });
});

describe("Cursor CLI output", () => {
  // As cursor-agent 2026.10.22-27dcf5f printed them for a run that read a file, called a Myrel tool and answered.
  const sid = "f72a35ca-6706-49e8-b85e-ad7313e6322d";
  const run = [
    { type: "system", subtype: "init", apiKeySource: "login", cwd: "/w", session_id: sid, model: "Auto", permissionMode: "default" },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "Read f.txt" }] }, session_id: sid },
    { type: "thinking", subtype: "delta", text: "Reading", session_id: sid, timestamp_ms: 1 },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "I'll read `f.txt` first." }] },
      session_id: sid,
      model_call_id: "m-0",
      timestamp_ms: 2,
    },
    {
      type: "tool_call",
      subtype: "started",
      call_id: "c1",
      tool_call: { readToolCall: { args: { path: "/w/f.txt" } }, hookAdditionalContexts: [], toolCallId: "c1", startedAtMs: "3" },
      session_id: sid,
    },
    {
      type: "tool_call",
      subtype: "started",
      call_id: "c2",
      tool_call: {
        mcpToolCall: {
          args: { name: "plugin-myrel-myrel-reply", args: { text: "secret42" }, providerIdentifier: "plugin-myrel-myrel", toolName: "reply" },
          description: "Send the content",
        },
        hookAdditionalContexts: [],
        toolCallId: "c2",
      },
      session_id: sid,
    },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "`f.txt` contains **secret42**." }] }, session_id: sid },
    {
      type: "result",
      subtype: "success",
      duration_ms: 9557,
      duration_api_ms: 9557,
      is_error: false,
      result: "I'll read `f.txt` first.`f.txt` contains **secret42**.",
      session_id: sid,
      request_id: "r",
      usage: { inputTokens: 13328, outputTokens: 114, cacheReadTokens: 22272, cacheWriteTokens: 10 },
    },
  ];

  it("reads the session, model, steps, answer and usage", () => {
    const state: ParseState = {};
    cursor.line(JSON.stringify(run[0]), state);
    expect(state).toMatchObject({ sessionId: sid, model: "Auto" });
    for (const event of run.slice(1, 5)) cursor.line(JSON.stringify(event), state);
    expect(state.progress).toBe("read: /w/f.txt");
    cursor.line(JSON.stringify(run[5]), state);
    expect(state.progress).toBe("reply");
    for (const event of run.slice(6)) cursor.line(JSON.stringify(event), state);
    // Its result glues the messages together; the answer is the last one.
    expect(state.result).toBe("`f.txt` contains **secret42**.");
    expect(state.failed).toBe(false);
    // Cache reads and writes count as input.
    expect(state.usage).toEqual({ inputTokens: 13328 + 22272 + 10, outputTokens: 114 });
  });

  it("shows a command as its command", () => {
    const state: ParseState = {};
    cursor.line(JSON.stringify({ type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: "npm test" } } } }), state);
    expect(state.progress).toBe("shell: npm test");
  });

  it("takes its result when no message came, and fails on an error result", () => {
    const ok: ParseState = {};
    cursor.line(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done." }), ok);
    expect(ok).toMatchObject({ result: "Done.", failed: false });
    const failed: ParseState = {};
    cursor.line(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "" }), failed);
    expect(failed.failed).toBe(true);
  });

  it("ignores lines that are not its JSON events", () => {
    const state: ParseState = {};
    cursor.line("Error: Authentication required.", state);
    expect(state).toEqual({});
  });
});

describe.skipIf(process.platform === "win32")("Cursor CLI as the thread's agent", () => {
  it("brings the run's servers and skills in plugins, and allows their tools in a config of the run", async () => {
    await mkdir(join(home, "own"), { recursive: true });
    await writeFile(
      join(home, "own", "cli-config.json"),
      JSON.stringify({ version: 1, model: { modelId: "default" }, permissions: { allow: ["Shell(ls)"], deny: ["Shell(rm)"] } }),
    );
    const dir = join(home, "run");
    await mkdir(join(dir, "plugin", "skills"), { recursive: true });
    const connectors = [
      { transport: "http" as const, name: "linear", url: "https://myrel.test/api/agent-mcp/thr_1/c/linear" },
      { transport: "stdio" as const, name: "db", command: "npx", args: ["-y", "pg-mcp"], env: { DATABASE_URL: "postgres://x" } },
    ];
    const token = "t".repeat(32);
    const agent = await cursor.agent({
      url: "https://myrel.test/api/agent-mcp/thr_1",
      token,
      dir,
      connectors,
      skills: { plugin: join(dir, "plugin"), dir: join(dir, "plugin", "skills") },
    });
    expect(agent.args).toEqual(["--approve-mcps", "--plugin-dir", join(dir, "myrel"), "--plugin-dir", join(dir, "plugin")]);
    expect(agent.env).toEqual({ CURSOR_CONFIG_DIR: join(dir, "cursor-config") });

    const headers = { Authorization: `Bearer ${token}` };
    expect(JSON.parse(await readFile(join(dir, "myrel", "mcp.json"), "utf8"))).toEqual({
      mcpServers: {
        myrel: { url: "https://myrel.test/api/agent-mcp/thr_1", headers },
        linear: { url: connectors[0]!.url, headers },
        db: { command: "npx", args: ["-y", "pg-mcp"], env: { DATABASE_URL: "postgres://x" } },
      },
    });
    // The token is in that file only, readable by this user alone.
    expect((await lstat(join(dir, "myrel", "mcp.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, "myrel", ".cursor-plugin", "plugin.json"), "utf8")).name).toBe("myrel");
    expect(JSON.parse(await readFile(join(dir, "plugin", ".cursor-plugin", "plugin.json"), "utf8")).name).toBe("myrel-skills");

    // The person's config, with the run's servers allowed; their own rules stay.
    const config = JSON.parse(await readFile(join(dir, "cursor-config", "cli-config.json"), "utf8"));
    expect(config).toEqual({
      version: 1,
      model: { modelId: "default" },
      permissions: {
        allow: ["Shell(ls)", "Mcp(plugin-myrel-myrel:*)", "Mcp(plugin-myrel-linear:*)", "Mcp(plugin-myrel-db:*)"],
        deny: ["Shell(rm)"],
      },
    });
    expect(JSON.stringify(config)).not.toContain(token);
  });

  it("links the person's chats, so the next turn resumes the chat", async () => {
    const dir = await cursorConfig(join(home, "cfg"), ["Mcp(plugin-myrel-myrel:*)"], join(home, "nobody"));
    expect(await readlink(join(dir, "chats"))).toBe(join(home, "nobody", "chats"));
    // No config of their own: a fresh one with the rule.
    expect(JSON.parse(await readFile(join(dir, "cli-config.json"), "utf8"))).toEqual({
      version: 1,
      permissions: { allow: ["Mcp(plugin-myrel-myrel:*)"] },
    });
  });
});

describe.skipIf(process.platform === "win32")("detectClis", () => {
  it("finds cursor-agent with its version", async () => {
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "cursor-agent"), '#!/bin/sh\necho "2026.10.22-27dcf5f"\n');
    await chmod(join(bin, "cursor-agent"), 0o755);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    expect(await detectClis()).toEqual([{ id: "cursor", version: "2026.10.22-27dcf5f" }]);
  });
});
