import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToServer, ServerToRunner } from "@altair/protocol";
import { ADAPTERS, type ParseState } from "./clis";
import type { RunnerConfig, SessionStore } from "./config";
import { threadWorktree, type Worktree } from "./worktrees";

type TaskStart = Extract<ServerToRunner, { type: "task.start" }>;
type Send = (frame: RunnerToServer) => void;

/** Results are cut to fit the protocol's limit. */
const MAX_RESULT = 90_000;
/** At most one progress frame per this many ms. */
const PROGRESS_EVERY_MS = 1000;

export type TaskRunnerOptions = {
  config: () => RunnerConfig;
  sessions: SessionStore;
  /** Kill a task after this long. Default 60 minutes. */
  timeoutMs?: number;
  /** For tests: replaces child_process.spawn. */
  spawn?: typeof spawn;
  log?: (line: string) => void;
};

/** Runs tasks the server sends, one CLI process per task, in shared folders only. */
export class TaskRunner {
  private readonly running = new Map<string, ChildProcess>();
  /** The worktree each running task works in. */
  private readonly worktrees = new Map<string, string>();
  /** Tasks the server asked to stop. */
  private readonly cancelled = new Set<string>();
  private send: Send = () => {};

  constructor(private readonly opts: TaskRunnerOptions) {}

  /** Where results go. Swapped on reconnect, so a task that outlives a connection still reports. */
  setSender(send: Send) {
    this.send = send;
  }

  runningIds(): string[] {
    return [...this.running.keys()];
  }

  /** Whether a task is running in this worktree right now. */
  inUse(w: Worktree): boolean {
    return [...this.worktrees.values()].includes(w.path);
  }

  async start(task: TaskStart): Promise<void> {
    const fail = (result: string) => this.send({ type: "task.done", taskId: task.taskId, ok: false, result });
    const config = this.opts.config();
    const folder = await sharedFolder(config, task.folder);
    if (!folder) return fail(`The folder ${task.folder} is not shared on this computer. Run \`myrel-runner share\` in it.`);

    // Read-only tasks change nothing, so they can share the folder.
    let isolated: Awaited<ReturnType<typeof threadWorktree>> = null;
    if (config.worktrees !== false && config.access !== "read") {
      try {
        isolated = await threadWorktree(folder, task.threadId);
      } catch (err) {
        return fail(
          `Could not make a git worktree for this thread in ${folder}: ${errorLine(err)}\nTo run tasks in the folder itself instead, run \`myrel-runner worktrees off\`.`,
        );
      }
    }
    const cwd = isolated?.cwd ?? folder;

    const adapter = ADAPTERS[task.cli];
    // A Claude Code session belongs to the folder it ran in, so a new worktree starts a new one.
    const resume = task.cli === "claude" && !isolated?.created ? await this.opts.sessions.get(task.threadId) : undefined;
    const log = this.opts.log ?? (() => {});
    log(`▶ ${adapter.id} in ${cwd}: ${task.prompt.split("\n")[0]!.slice(0, 80)}`);

    // As the thread's agent, the CLI reaches the thread's MCP endpoint on this runner's server.
    let agentDir: string | undefined;
    let agent: { args: string[]; env?: Record<string, string> } = { args: [] };
    if (task.agent && config.server) {
      agentDir = await mkdtemp(join(tmpdir(), "altair-agent-"));
      const url = `${config.server.replace(/\/$/, "")}${task.agent.mcpPath}`;
      agent = await adapter.agent({ url, token: task.agent.token, dir: agentDir });
    }
    const cleanup = () => (agentDir ? rm(agentDir, { recursive: true, force: true }).catch(() => {}) : Promise.resolve());

    const child = (this.opts.spawn ?? spawn)(adapter.bin, adapter.args({ access: config.access, resume, extra: agent.args }), {
      cwd,
      env: { ...process.env, ...agent.env },
      stdio: ["pipe", "pipe", "pipe"],
      // Windows CLIs are .cmd shims. Only fixed flags are on the command line; the prompt goes on stdin.
      shell: process.platform === "win32",
    });
    this.running.set(task.taskId, child);
    if (isolated) this.worktrees.set(task.taskId, isolated.worktree.path);
    // Tells Myrel where the work is, since it is not in the shared folder itself.
    const where = isolated
      ? `\n\n(myrel-runner: worked on branch ${isolated.worktree.branch} in ${isolated.cwd}, a git worktree of ${folder}.)`
      : "";

    const state: ParseState = {};
    let stdout = "";
    let stderr = "";
    let buffered = "";
    let lastProgress = 0;
    let sentProgress: string | undefined;
    const flushProgress = () => {
      if (!state.progress || state.progress === sentProgress) return;
      sentProgress = state.progress;
      lastProgress = Date.now();
      this.send({ type: "task.progress", taskId: task.taskId, text: state.progress });
    };

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (stdout.length < 4 * MAX_RESULT) stdout += chunk;
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop()!;
      for (const line of lines) adapter.line(line.trim(), state);
      if (Date.now() - lastProgress >= PROGRESS_EVERY_MS) flushProgress();
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    child.stdin!.on("error", () => {}); // the CLI may exit before reading all of stdin
    child.stdin!.end(task.prompt);

    const timer = setTimeout(() => child.kill("SIGTERM"), this.opts.timeoutMs ?? 60 * 60 * 1000);

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (ok: boolean, result: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        void cleanup();
        this.running.delete(task.taskId);
        this.worktrees.delete(task.taskId);
        if (this.cancelled.delete(task.taskId)) {
          log(`■ ${adapter.id} task stopped`);
          this.send({ type: "task.done", taskId: task.taskId, ok: false, cancelled: true, result: "Stopped from Myrel." });
          return resolve();
        }
        log(`${ok ? "✓" : "✗"} ${adapter.id} task finished`);
        this.send({ type: "task.done", taskId: task.taskId, ok, result: result.slice(0, MAX_RESULT - where.length) + where });
        resolve();
      };
      child.on("error", (err: NodeJS.ErrnoException) => {
        finish(
          false,
          err.code === "ENOENT"
            ? `${adapter.bin} is not installed on this computer, or not on PATH for myrel-runner.`
            : `Could not start ${adapter.bin}: ${err.message}`,
        );
      });
      // A stopped CLI can leave children holding its output open, so "close" may come late.
      child.on("exit", () => {
        if (this.cancelled.has(task.taskId)) finish(false, "");
      });
      child.on("close", async (code, signal) => {
        if (buffered.trim()) adapter.line(buffered.trim(), state);
        adapter.end?.(stdout, state);
        if (state.sessionId && task.cli === "claude") await this.opts.sessions.set(task.threadId, state.sessionId).catch(() => {});
        const ok = code === 0 && !state.failed;
        const result =
          state.result ??
          (ok ? stdout.trim() : `${adapter.bin} exited with ${signal ?? `code ${code}`}.\n${stderr.trim() || stdout.trim()}`);
        finish(ok, result || "(no output)");
      });
    });
  }

  /** Stops one task, as asked from Myrel. Its "task.done" says it was cancelled. */
  cancel(taskId: string) {
    const child = this.running.get(taskId);
    if (!child) return;
    this.cancelled.add(taskId);
    child.kill("SIGTERM");
    setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000).unref();
  }

  /** Stops every running task, e.g. when this computer is unpaired. */
  stopAll() {
    for (const child of this.running.values()) child.kill("SIGTERM");
  }
}

/** The shared folder `requested` is (after resolving symlinks), or null. Never trust the server's path alone. */
export async function sharedFolder(config: RunnerConfig, requested: string): Promise<string | null> {
  const real = await realpath(requested).catch(() => null);
  if (!real) return null;
  for (const f of config.folders) {
    if ((await realpath(f.path).catch(() => null)) === real) return real;
  }
  return null;
}

const errorLine = (err: unknown) =>
  ((err as { stderr?: string }).stderr || (err as Error).message || String(err)).trim().split("\n").at(-1);
