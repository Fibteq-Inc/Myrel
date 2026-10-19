import { type ChildProcess, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { RunnerToServer, ServerToRunner } from "@altair/protocol";
import { ADAPTERS, type ParseState } from "./clis";
import type { RunnerConfig, SessionStore } from "./config";

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
  private send: Send = () => {};

  constructor(private readonly opts: TaskRunnerOptions) {}

  /** Where results go. Swapped on reconnect, so a task that outlives a connection still reports. */
  setSender(send: Send) {
    this.send = send;
  }

  runningIds(): string[] {
    return [...this.running.keys()];
  }

  async start(task: TaskStart): Promise<void> {
    const fail = (result: string) => this.send({ type: "task.done", taskId: task.taskId, ok: false, result });
    const config = this.opts.config();
    const folder = await sharedFolder(config, task.folder);
    if (!folder) return fail(`The folder ${task.folder} is not shared on this computer. Run \`altair-runner share\` in it.`);

    const adapter = ADAPTERS[task.cli];
    const resume = task.cli === "claude" ? await this.opts.sessions.get(task.threadId) : undefined;
    const log = this.opts.log ?? (() => {});
    log(`▶ ${adapter.id} in ${folder}: ${task.prompt.split("\n")[0]!.slice(0, 80)}`);

    const child = (this.opts.spawn ?? spawn)(adapter.bin, adapter.args({ access: config.access, resume }), {
      cwd: folder,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Windows CLIs are .cmd shims. Only fixed flags are on the command line; the prompt goes on stdin.
      shell: process.platform === "win32",
    });
    this.running.set(task.taskId, child);

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
        this.running.delete(task.taskId);
        log(`${ok ? "✓" : "✗"} ${adapter.id} task finished`);
        this.send({ type: "task.done", taskId: task.taskId, ok, result: result.slice(0, MAX_RESULT) });
        resolve();
      };
      child.on("error", (err: NodeJS.ErrnoException) => {
        finish(
          false,
          err.code === "ENOENT"
            ? `${adapter.bin} is not installed on this computer, or not on PATH for altair-runner.`
            : `Could not start ${adapter.bin}: ${err.message}`,
        );
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
