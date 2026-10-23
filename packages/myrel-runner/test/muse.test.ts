import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToServer } from "@myrel/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADAPTERS, detectClis, type ParseState, parseMuseCatalog } from "../src/clis";
import { type RunnerConfig, SessionStore } from "../src/config";
import { TaskRunner } from "../src/tasks";

const muse = ADAPTERS.muse;

let home: string;
const savedPath = process.env.PATH;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "myrel-muse-"));
  process.env.MYREL_RUNNER_HOME = home;
});
afterEach(() => {
  process.env.PATH = savedPath;
});

/** A stand-in `muse` alone on PATH. */
async function fakeMuse(script: string) {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "muse"), script);
  await chmod(join(bin, "muse"), 0o755);
  process.env.PATH = `${bin}:/usr/bin:/bin`;
}

describe("Muse Code arguments", () => {
  it("runs exec with JSON events and the prompt in a file", () => {
    const file = ["--prompt-file", "/tmp/p/prompt.md"];
    // Its read-only profile would wait forever on a command, so read takes writes and the shell away.
    expect(muse.args({ access: "read", promptFile: "/tmp/p/prompt.md" })).toEqual([
      "exec",
      "--json",
      "--approval-mode",
      "never",
      "--disable-write",
      "--disable-shell",
      ...file,
    ]);
    // Its sandbox keeps writes in the workspace; nothing waits for approval.
    expect(muse.args({ access: "edit", promptFile: "/tmp/p/prompt.md" })).toEqual(["exec", "--json", "--approval-mode", "never", "--trust-workspace", ...file]);
    expect(muse.args({ access: "auto", promptFile: "/tmp/p/prompt.md" })).toEqual(["exec", "--json", "--approval-mode", "never", "--trust-workspace", ...file]);
    expect(muse.args({ access: "full", promptFile: "/tmp/p/prompt.md" })).toEqual(["exec", "--json", "--yolo", ...file]);
    // The session continues with --session-id; the prompt file comes last.
    expect(muse.args({ access: "full", resume: "01a1-s", extra: ["-c", "x"], promptFile: "/tmp/p/prompt.md" })).toEqual([
      "exec",
      "--json",
      "--yolo",
      "--session-id",
      "01a1-s",
      "-c",
      "x",
      ...file,
    ]);
    expect(muse.promptFile).toBe(true);
  });

  it("gives each server its own -c override, with secrets only as ${VAR}", async () => {
    const { args, env } = await muse.agent({
      url: "https://myrel.test/mcp/thr_1",
      token: "tok",
      dir: home,
      connectors: [
        { transport: "http", name: "linear", url: "https://myrel.test/mcp/thr_1/linear" },
        { transport: "stdio", name: "files", command: "npx", args: ["-y", "files-mcp"], env: { API_KEY: "k1" } },
      ],
    });
    const headers = { Authorization: "${MYREL_MCP_AUTH}" };
    expect(args).toEqual([
      "-c",
      `mcpServers.myrel=${JSON.stringify({ url: "https://myrel.test/mcp/thr_1", headers })}`,
      "-c",
      `mcpServers.linear=${JSON.stringify({ url: "https://myrel.test/mcp/thr_1/linear", headers })}`,
      "-c",
      `mcpServers.files=${JSON.stringify({ command: "npx", args: ["-y", "files-mcp"], env: { API_KEY: "${MYREL_MCP_1_0}" } })}`,
    ]);
    // The token never goes on the command line.
    expect(args.join(" ")).not.toContain("tok");
    expect(env).toEqual({ MYREL_MCP_AUTH: "Bearer tok", MYREL_MCP_1_0: "k1" });
  });
});

describe("Muse Code output", () => {
  // Shaped as Muse Code 1.4.12 printed them for a run that wrote a file, ran a command, called an MCP tool and answered.
  const sid = "01a16969-4a1e-7d01-9d8d-5f3c2b7a9e11";
  const run = "01a16969-553a-7463-9a2b-b2a1c7cd5ceb";
  const ev = (payload_type: string, payload: Record<string, unknown>, kind = "session") => ({
    schema_version: 1,
    stream: { kind, id: kind === "session" ? sid : "x" },
    payload_type,
    payload: { run_stream: { kind: "run", id: run }, ...payload },
  });
  const lines = [
    ev("run.model.configured", { kind: "run_model_configured", provider_id: "meta", model_id: "muse-spark-1.3" }),
    ev("task.lifecycle.proposed", { event: { kind: "proposed", task_kind: "model.meta.response" } }),
    ev("run.output.delta", { text: "Writing the file." }),
    ev("task.lifecycle.proposed", { event: { kind: "proposed", task_kind: "tool.write_file" } }),
    ev("tool.result", {
      text: "wrote 1 bytes to /w/inside.txt",
      edit_facts: { tool_name: "write_file", path: "inside.txt", added: 1 },
      correlation_facts: { tool_name: "write_file", outcome: "success" },
    }),
    ev("task.lifecycle.proposed", { event: { kind: "proposed", task_kind: "tool.bash" } }),
    ev("tool.result", { text: JSON.stringify({ command: "echo B > shell.txt", exit_code: 0 }, null, 2), correlation_facts: { tool_name: "bash" } }),
    ev("task.lifecycle.proposed", { event: { kind: "proposed", task_kind: "tool.mcp__myrel__reply" } }),
    ev("run.output.delta", { text: "Done" }),
    ev("run.output.delta", { text: ": all worked." }),
    ev("run.usage", { models: [{ model: "muse-spark-1.3", input_tokens: 181661, cached_tokens: 150453, output_tokens: 961, reasoning_tokens: 380 }] }),
    ev("run.terminal.completed", { terminal: "completed", text: "Done: all worked.", reason: null }),
    ev("run.usage", { allowance: {} }, "exec.usage"),
  ];

  it("reads the session, model, steps, usage and answer", () => {
    const state: ParseState = {};
    const progress: string[] = [];
    for (const line of lines) {
      muse.line(JSON.stringify(line), state);
      if (state.progress && state.progress !== progress.at(-1)) progress.push(state.progress);
    }
    expect(state.sessionId).toBe(sid);
    expect(state.model).toBe("muse-spark-1.3");
    expect(progress).toEqual([
      "Writing the file.",
      "write_file",
      "write_file: inside.txt",
      "bash",
      "$ echo B > shell.txt",
      "mcp__myrel__reply",
      "Done",
      "Done: all worked.",
    ]);
    // Input already holds the cached tokens.
    expect(state.usage).toEqual({ inputTokens: 181661, outputTokens: 961 });
    expect(state.result).toBe("Done: all worked.");
    expect(state.failed).toBe(false);
  });

  it("fails a run that did not complete, with its reason", () => {
    const state: ParseState = {};
    muse.line(JSON.stringify(ev("run.terminal.failed", { terminal: "failed", text: "", reason: "provider unavailable" })), state);
    expect(state).toMatchObject({ failed: true, result: "provider unavailable" });
  });
});

describe("Muse Code detection", () => {
  it("finds Muse Code, and not another tool called muse", async () => {
    await fakeMuse('#!/bin/sh\necho "Muse Code 1.4.12 (1.4.12-R6909.1)"\n');
    expect(await detectClis()).toEqual([{ id: "muse", version: "Muse Code 1.4.12 (1.4.12-R6909.1)" }]);
    await fakeMuse('#!/bin/sh\necho "muse 0.3.1"\n');
    expect(await detectClis()).toEqual([]);
  });
});

describe("Muse Code task", () => {
  it("passes the prompt in a private file, deleted after the run, and saves the session", async () => {
    // Prints what it got: the prompt file's text and mode, then an answer.
    await fakeMuse(`#!/bin/sh
while [ $# -gt 0 ]; do [ "$1" = "--prompt-file" ] && f="$2"; shift; done
mode=$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")
text=$(cat "$f")
echo '{"stream":{"kind":"session","id":"s-1"},"payload_type":"run.model.configured","payload":{"model_id":"muse-spark-1.3"}}'
echo "{\\"stream\\":{\\"kind\\":\\"session\\",\\"id\\":\\"s-1\\"},\\"payload_type\\":\\"run.terminal.completed\\",\\"payload\\":{\\"terminal\\":\\"completed\\",\\"text\\":\\"$mode $text $f\\"}}"
`);
    const folder = await mkdtemp(join(tmpdir(), "myrel-muse-folder-"));
    const config: RunnerConfig = { folders: [{ path: folder, name: "code" }], access: "edit", worktrees: false };
    const sessions = new SessionStore();
    const frames: RunnerToServer[] = [];
    const runner = new TaskRunner({ config: () => config, sessions });
    runner.setSender((f) => frames.push(f));
    const threadId = "thr_01JTEST0000000000000000000";
    await runner.start({ type: "task.start", taskId: "task_01JTEST0000000000000000000", threadId, folder, cli: "muse", prompt: "hello" });
    await expect.poll(() => frames.find((f) => f.type === "task.done")).toBeTruthy();
    const done = frames.find((f) => f.type === "task.done") as { ok: boolean; result: string };
    expect(done.ok).toBe(true);
    const [mode, text, file] = done.result.split(" ");
    expect([mode, text]).toEqual(["600", "hello"]);
    await expect.poll(() => import("node:fs").then((fs) => fs.existsSync(file!))).toBe(false);
    expect(await sessions.get(threadId, "muse")).toMatchObject({ id: "s-1" });
  });
});

describe("Muse Code models", () => {
  it("lists the catalog's visible models with their effort tiers", () => {
    const tiers = (...t: string[]) => t.map((tier) => ({ tier, description: null }));
    const catalog = JSON.stringify({
      schema_version: 2,
      provider_id: "meta",
      rows: [
        { model_id: "muse-wonder-1.0", display_label: "muse-wonder-1.0", visibility: "visible", reasoning_effort_variants: tiers("low", "high", "max") },
        { model_id: "muse-wonder-1.0-contributor", visibility: "hidden", reasoning_effort_variants: tiers("low") },
        { model_id: "muse-spark-1.3", visibility: "visible", reasoning_effort_variants: null },
      ],
    });
    expect(parseMuseCatalog(catalog)).toEqual([
      { id: "muse-wonder-1.0", name: "muse-wonder-1.0", efforts: ["low", "high", "max"] },
      { id: "muse-spark-1.3", name: "muse-spark-1.3", efforts: [] },
    ]);
    expect(parseMuseCatalog("not json")).toBeUndefined();
  });

  it("runs the picked model and effort", () => {
    expect(muse.modelArgs!({ model: "muse-spark-1.3", effort: "low" })).toEqual(["--model", "muse-spark-1.3", "--effort", "low"]);
    expect(muse.modelArgs!({ effort: "high" })).toEqual(["--effort", "high"]);
  });
});
