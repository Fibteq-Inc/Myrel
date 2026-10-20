import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeCode,
  emptyProgress,
  formatMarker,
  LineSplitter,
  opencode,
  opencodeConfig,
  parseLine,
  parseMarker,
  reduceTask,
  renderChecklist,
  type RunnerEvent,
  SETUP_NOTE,
  shell,
  taskBranch,
  taskEnv,
  taskScript,
  TaskSpec,
} from "../src";

const spec = (over: Partial<TaskSpec> = {}) =>
  TaskSpec.parse({ taskId: "task_01JABCDEFGHJKMNPQRSTVWXYZ", title: "Fix the login bug", prompt: "Fix it", ...over });

describe("lines", () => {
  it("splits chunks into lines across boundaries", () => {
    const s = new LineSplitter();
    expect(s.push("a\nb")).toEqual(["a"]);
    expect(s.push(new TextEncoder().encode("c\r\nd"))).toEqual(["bc"]);
    expect(s.end()).toEqual(["d"]);
  });

  it("round-trips marker lines and rejects bad ones", () => {
    const e: RunnerEvent = { type: "pr", url: "https://github.com/a/b/pull/1" };
    expect(parseMarker(formatMarker(e))).toEqual(e);
    expect(parseMarker("::altair::{nope")).toBeNull();
    expect(parseMarker('::altair::{"type":"what"}')).toBeNull();
    expect(parseLine(shell, formatMarker(e))).toEqual([e]);
  });
});

describe("opencode", () => {
  it("maps its JSON events", () => {
    const line = (o: unknown) => opencode.parse(JSON.stringify(o));
    expect(line({ type: "text", part: { text: " Done. " } })).toEqual([{ type: "text", text: "Done." }]);
    expect(
      line({
        type: "tool_use",
        part: { tool: "todowrite", state: { input: { todos: [{ content: "Read", status: "completed" }, { content: "Fix", status: "in_progress" }] } } },
      }),
    ).toEqual([{ type: "todos", items: [{ text: "Read", status: "done" }, { text: "Fix", status: "in_progress" }] }]);
    expect(line({ type: "tool_use", part: { tool: "bash", state: { title: "pnpm test", output: "ok\n" } } })).toEqual([
      { type: "tool", name: "bash", title: "pnpm test" },
      { type: "log", stream: "stdout", text: "ok" },
    ]);
    expect(line({ type: "step_finish", part: { tokens: { input: 10, output: 5 }, cost: 0.01 } })).toEqual([
      { type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    ]);
    expect(opencode.parse("plain output")).toEqual([{ type: "log", stream: "stdout", text: "plain output" }]);
  });

  it("registers OpenAI-compatible models as a custom provider without the key", () => {
    const s = spec({ model: { kind: "openai", provider: "fireworks", id: "firerouter/opus", baseUrl: "https://api.fireworks.ai/inference/v1" } });
    expect(opencode.command(s)).toBe(`opencode run --format json --model 'altair/firerouter/opus' "$ALTAIR_PROMPT"`);
    const config = JSON.stringify(opencodeConfig(s));
    expect(config).toContain("{env:ALTAIR_MODEL_API_KEY}");
    expect(config).toContain("https://api.fireworks.ai/inference/v1");
  });

  it("connects to the thread's MCP endpoint as the thread's agent, with the token from the environment", () => {
    expect(opencodeConfig(spec()).mcp).toBeUndefined();
    const config = opencodeConfig(spec({ mcp: { url: "https://altair.test/api/agent-mcp/thr_1" } }));
    expect(config.mcp).toEqual({
      altair: {
        type: "remote",
        url: "https://altair.test/api/agent-mcp/thr_1",
        enabled: true,
        headers: { Authorization: "Bearer {env:ALTAIR_MCP_TOKEN}" },
      },
    });
  });
});

describe("claude code", () => {
  it("maps stream-json events", () => {
    const events = claudeCode.parse(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Looking" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      }),
    );
    expect(events).toEqual([
      { type: "text", text: "Looking" },
      { type: "tool", name: "Bash", title: "ls" },
    ]);
  });
});

describe("progress", () => {
  it("renders phases and the harness's plan as a checklist", () => {
    const events: RunnerEvent[] = [
      { type: "phase", phase: "prepare", state: "done" },
      { type: "phase", phase: "clone", state: "skipped" },
      { type: "phase", phase: "agent", state: "started" },
      { type: "todos", items: [{ text: "Find the bug", status: "done" }, { text: "Fix it", status: "in_progress" }] },
      { type: "tool", name: "edit", title: "src/login.ts" },
    ];
    const p = events.reduce(reduceTask, emptyProgress());
    expect(renderChecklist("Fix the login bug", p)).toBe(
      [
        "Fix the login bug",
        "",
        "✓ Opened the sandbox",
        "✱ Working: src/login.ts",
        "  ✓ Find the bug",
        "  ✱ Fix it",
        "○ Open the pull request",
      ].join("\n"),
    );
  });

  it("says when the sandbox is installing its tools", () => {
    const p = reduceTask(emptyProgress(), { type: "phase", phase: "prepare", state: "started", detail: SETUP_NOTE });
    expect(renderChecklist("Run", p, "tr").split("\n")[2]).toBe(
      "✱ Sandbox açılıyor: araçlar kuruluyor, yalnızca ilk sefer (birkaç dakika)",
    );
  });

  it("names branches after the task", () => {
    expect(taskBranch({ taskId: "task_01JABCDEFGHJKMNPQRSTVWXYZ", title: "Giriş hatasını düzelt!" })).toBe(
      "altair/giris-hatasini-duzelt-tvwxyz",
    );
  });
});

/** Runs the real task script with bash, like a sandbox would. */
function runScript(env: Record<string, string>) {
  const res = spawnSync("bash", ["-c", taskScript()], {
    env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), "altair-home-")), ...env },
    encoding: "utf8",
  });
  const events = res.stdout.split("\n").flatMap((l) => parseLine(shell, l));
  return { code: res.status, events, stderr: res.stderr };
}

describe("task script", () => {
  it("clones the repository, runs the harness on a fresh branch and reports phases", () => {
    const origin = mkdtempSync(join(tmpdir(), "altair-origin-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: origin, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    const workdir = mkdtempSync(join(tmpdir(), "altair-work-"));

    const s = spec({ harness: "shell", prompt: "echo hello > out.txt && git branch --show-current", repo: { url: `file://${origin}` } });
    const { code, events, stderr } = runScript(taskEnv(s, shell, { workdir }));
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const repoDir = join(workdir, origin.split("/").pop()!);
    expect(readFileSync(join(repoDir, "out.txt"), "utf8")).toBe("hello\n");
    expect(events).toContainEqual({ type: "log", stream: "stdout", text: taskBranch(s) });
    expect(events.filter((e) => e.type === "phase").map((e) => `${e.phase}:${e.state}`)).toEqual([
      "prepare:started",
      "prepare:done",
      "clone:started",
      "clone:done",
      "agent:started",
      "agent:done",
      "publish:skipped",
    ]);
  });

  it("saves every result to the workspace and starts the next task from it", () => {
    const remote = mkdtempSync(join(tmpdir(), "altair-ws-"));
    execFileSync("git", ["init", "-q", "--bare", remote]);
    const workspace = { remote: `file://${remote}` };
    // Each task gets a fresh workdir, like a sandbox that went to sleep in between.
    const run = (prompt: string) =>
      runScript(taskEnv(spec({ harness: "shell", prompt, workspace }), shell, { workdir: mkdtempSync(join(tmpdir(), "altair-work-")) }));

    const first = run("echo one > notes.txt");
    expect(first.code).toBe(0);
    expect(first.events.filter((e) => e.type === "phase" && e.phase === "save").map((e) => e.type === "phase" && e.state)).toEqual([
      "started",
      "done",
    ]);

    const second = run("cat notes.txt && echo two >> notes.txt && exit 4");
    expect(second.code).toBe(4);
    expect(second.events).toContainEqual({ type: "log", stream: "stdout", text: "one" });
    expect(second.events).toContainEqual({ type: "log", stream: "system", text: "Continuing from the work saved in this thread." });
    expect(second.events.at(-1)).toMatchObject({ type: "phase", phase: "save", state: "done" });

    // Unfinished work is saved too, marked as such.
    const log = execFileSync("git", ["--git-dir", remote, "log", "--format=%s", "main"], { encoding: "utf8" });
    expect(log.trim().split("\n")).toEqual(["Fix the login bug (unfinished)", "Fix the login bug"]);
  });

  it("continues a repository branch from the saved work", () => {
    const origin = mkdtempSync(join(tmpdir(), "altair-origin-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: origin });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: origin });
    const remote = mkdtempSync(join(tmpdir(), "altair-ws-"));
    execFileSync("git", ["init", "-q", "--bare", remote]);
    const run = (prompt: string) =>
      runScript(
        taskEnv(
          spec({ harness: "shell", prompt, repo: { url: `file://${origin}`, branch: "fix" }, workspace: { remote: `file://${remote}` } }),
          shell,
          { workdir: mkdtempSync(join(tmpdir(), "altair-work-")) },
        ),
      );
    expect(run("echo draft > fix.txt").code).toBe(0);
    const second = run("cat fix.txt");
    expect(second.code).toBe(0);
    expect(second.events).toContainEqual({ type: "log", stream: "stdout", text: "draft" });
  });

  it("goes on without saving when the workspace cannot be reached", () => {
    const workdir = mkdtempSync(join(tmpdir(), "altair-work-"));
    const s = spec({ harness: "shell", prompt: "true", workspace: { remote: "file:///nonexistent/altair-ws" } });
    const { code, events } = runScript(taskEnv(s, shell, { workdir }));
    expect(code).toBe(0);
    expect(events.some((e) => e.type === "phase" && e.phase === "save")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "log", stream: "system", text: expect.stringContaining("will not be saved") }));
  });

  it("fails the agent phase with the harness's exit code", () => {
    const workdir = mkdtempSync(join(tmpdir(), "altair-work-"));
    writeFileSync(join(workdir, "x"), "");
    const { code, events } = runScript(taskEnv(spec({ harness: "shell", prompt: "exit 3" }), shell, { workdir }));
    expect(code).toBe(3);
    expect(events.at(-1)).toEqual({ type: "phase", phase: "agent", state: "failed", detail: "Shell exited with code 3" });
  });
});
