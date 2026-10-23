import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliId, CliLimits, RunnerToServer, ServerToRunner } from "@myrel/protocol";
import { type AcpMcpServer, AcpTurn } from "./acp";
import { ADAPTERS, type CliAdapter, type ParseState } from "./clis";
import { childEnv, type RunnerConfig, type SessionStore } from "./config";
import { downloadSkills, type RunSkills } from "./skills";
import { threadWorktree, type Worktree } from "./worktrees";

type TaskStart = Extract<ServerToRunner, { type: "task.start" }>;
type Send = (frame: RunnerToServer) => void;

/** The CLIs whose sessions a thread's next turn continues. */
const RESUMES = new Set<CliId>(["claude", "codex", "antigravity", "opencode", "hermes", "cursor"]);
/** Results are cut to fit the protocol's limit. */
const MAX_RESULT = 90_000;
/** At most one progress frame per this many ms. */
const PROGRESS_EVERY_MS = 1000;

export type TaskRunnerOptions = {
  config: () => RunnerConfig;
  sessions: SessionStore;
  /** Called whenever a task starts or ends, e.g. to tell `myrel-runner update` what is running. */
  onChange?: (running: string[]) => void;
  /** Kill a task after this long. Default 60 minutes. */
  timeoutMs?: number;
  /** For tests: replaces child_process.spawn. */
  spawn?: typeof spawn;
  log?: (line: string) => void;
  /** The subscription limits a CLI reported during or after a run. */
  onLimits?: (cli: CliId, limits: CliLimits) => void;
};

/** Runs tasks the server sends, one CLI process per task, in shared folders only. */
export class TaskRunner {
  private readonly running = new Map<string, ChildProcess>();
  /** The worktree each running task works in. */
  private readonly worktrees = new Map<string, string>();
  /** Tasks the server asked to stop. */
  private readonly cancelled = new Set<string>();
  /** Tasks stopped because this runner shuts down: the server continues them after it restarts. */
  private readonly interrupted = new Set<string>();
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
    const log = this.opts.log ?? (() => {});

    // The project's other folders, each only when it is shared too; the main one when a worktree is the cwd.
    const dirs: string[] = cwd === folder ? [] : [folder];
    for (const requested of task.folders ?? []) {
      const other = await sharedFolder(config, requested);
      if (!other) log(`  skipping ${requested}: not shared on this computer`);
      else if (other !== cwd && !dirs.includes(other)) dirs.push(other);
    }

    const adapter = ADAPTERS[task.cli];
    // Claude Code asks the person through Myrel before stepping outside those folders.
    const asks = !!task.agent && task.cli === "claude";
    // A CLI session belongs to the folder it ran in, so a new worktree starts a new one.
    const session = RESUMES.has(task.cli) && !isolated?.created ? await this.opts.sessions.get(task.threadId, task.cli) : undefined;
    // A session that saw the thread's last turn already holds the thread: it only needs what is new.
    const short = session && task.agent?.resume && session.task === task.agent.resume.after ? task.agent.resume.prompt : undefined;
    log(`▶ ${adapter.id} in ${cwd}: ${task.prompt.split("\n")[0]!.slice(0, 80)}`);

    // As the thread's agent, the CLI reaches the thread's MCP endpoint on this runner's server.
    let agentDir: string | undefined;
    let agent: { args: string[]; env?: Record<string, string>; mcpServers?: AcpMcpServer[] } = { args: [] };
    let skills: RunSkills | null = null;
    if (task.agent && config.server) {
      agentDir = await mkdtemp(join(tmpdir(), "myrel-agent-"));
      const origin = config.server.replace(/\/$/, "");
      const connectors = (task.agent.connectors ?? []).map((c) =>
        c.transport === "http" ? { transport: c.transport, name: c.name, url: `${origin}${c.path}` } : c,
      );
      skills = task.agent.skills ? await downloadSkills(`${origin}${task.agent.skills.path}`, task.agent.token, agentDir) : null;
      agent = await adapter.agent({
        url: `${origin}${task.agent.mcpPath}`,
        token: task.agent.token,
        dir: agentDir,
        connectors,
        asks,
        access: config.access,
        dirs,
        ...(skills && { skills: { plugin: skills.plugin, dir: skills.skills } }),
      });
    }
    const cleanup = () => (agentDir ? rm(agentDir, { recursive: true, force: true }).catch(() => {}) : Promise.resolve());

    // Tells Myrel where the work is, since it is not in the shared folder itself.
    const where = isolated
      ? `\n\n(myrel-runner: worked on branch ${isolated.worktree.branch} in ${isolated.cwd}, a git worktree of ${folder}.)`
      : "";
    if (isolated) this.worktrees.set(task.taskId, isolated.worktree.path);
    // Where the CLI works without asking, so Myrel only asks about what is really outside.
    if (task.agent) this.send({ type: "task.folders", taskId: task.taskId, folders: [cwd, ...dirs] });

    // A session that cannot be resumed (deleted, or from another CLI version) fails before any
    // output: the turn then starts a new session with the whole thread.
    const retry = await this.attempt(task, { cwd, adapter, agent, dirs, asks: asks && !!agentDir, skills, where, cleanup }, session?.id, short ?? task.prompt);
    if (retry) {
      log(`  could not resume the ${adapter.id} session; starting a new one`);
      await this.attempt(task, { cwd, adapter, agent, dirs, asks: asks && !!agentDir, skills, where, cleanup }, undefined, task.prompt);
    }
  }

  /** One run of the CLI. True when a resumed session failed before any output, so the caller can start a new one. */
  private async attempt(
    task: TaskStart,
    run: {
      cwd: string;
      adapter: CliAdapter;
      agent: { args: string[]; env?: Record<string, string>; mcpServers?: AcpMcpServer[] };
      dirs: string[];
      asks: boolean;
      skills: RunSkills | null;
      where: string;
      cleanup: () => Promise<unknown>;
    },
    resume: string | undefined,
    prompt: string,
  ): Promise<boolean> {
    const config = this.opts.config();
    const log = this.opts.log ?? (() => {});
    const { cwd, adapter, agent, dirs, skills, where, cleanup } = run;
    const args = adapter.args({ access: config.access, resume, extra: agent.args, dirs, asks: run.asks });
    const child = (this.opts.spawn ?? spawn)(adapter.bin, args, {
      cwd,
      env: childEnv(agent.env),
      stdio: ["pipe", "pipe", "pipe"],
      // Windows CLIs are .cmd shims. Only fixed flags are on the command line; the prompt goes on stdin.
      shell: process.platform === "win32",
    });
    this.running.set(task.taskId, child);
    this.opts.onChange?.(this.runningIds());

    const state: ParseState = {};
    let stdout = "";
    let stderr = "";
    let buffered = "";
    let lastProgress = 0;
    let sentProgress: string | undefined;
    let sentUsage = "";
    let sentLimits: CliLimits | undefined;
    let savedSession: string | undefined;
    const reportLimits = (limits: CliLimits | undefined) => {
      if (!limits || limits === sentLimits) return;
      sentLimits = limits;
      this.opts.onLimits?.(task.cli, limits);
    };
    /** The CLI's usage so far, for the server to show under the agent's replies. */
    const usage = () => (state.usage ? { ...state.usage, ...(state.model && { model: state.model.slice(0, 200) }) } : undefined);
    const flushProgress = () => {
      const u = usage();
      const usageKey = u ? JSON.stringify(u) : "";
      const textChanged = !!state.progress && state.progress !== sentProgress;
      if (!textChanged && usageKey === sentUsage) return;
      sentProgress = state.progress;
      sentUsage = usageKey;
      lastProgress = Date.now();
      // Unchanged text goes as empty, so the server does not log the same step twice.
      this.send({ type: "task.progress", taskId: task.taskId, text: textChanged ? state.progress! : "", ...(u && { usage: u }) });
    };

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (stdout.length < 4 * MAX_RESULT) stdout += chunk;
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop()!;
      for (const line of lines) adapter.line(line.trim(), state);
      reportLimits(state.limits);
      // Saved as soon as the CLI names it, not only at the end: a run stopped midway (the runner
      // restarting for an update) is then continued in the same session instead of a new one.
      if (state.sessionId && state.sessionId !== savedSession && RESUMES.has(task.cli)) {
        savedSession = state.sessionId;
        void this.opts.sessions.set(task.threadId, task.cli, { id: state.sessionId, task: task.taskId }).catch(() => {});
      }
      // New usage goes at once, so a reply the agent sends right after can count it.
      const u = usage();
      if (Date.now() - lastProgress >= PROGRESS_EVERY_MS || (u && JSON.stringify(u) !== sentUsage)) flushProgress();
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    child.stdin!.on("error", () => {}); // the CLI may exit before reading all of stdin
    // The prompt lists the skills; only the runner knows where they are on this computer.
    const text = skills ? `${prompt}\n\nSkills folder for this run: ${skills.skills}` : prompt;
    const input = adapter.input ? adapter.input(text, config.access) : text;
    if (adapter.acp) {
      // An ACP agent gets the prompt in a session; the turn ends its stdin once the prompt is answered.
      const io = { write: (line: string) => void child.stdin!.write(line), end: () => child.stdin!.end() };
      state.acp = new AcpTurn(io, { cwd, prompt: input, mcpServers: agent.mcpServers ?? [], resume, ...adapter.acp(config.access) }, state);
      state.acp.start();
    } else child.stdin!.end(input);

    const timer = setTimeout(() => child.kill("SIGTERM"), this.opts.timeoutMs ?? 60 * 60 * 1000);

    return await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean, result: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        void cleanup();
        this.running.delete(task.taskId);
        this.worktrees.delete(task.taskId);
        this.opts.onChange?.(this.runningIds());
        // The next runner reports it as interrupted; a failure sent now would end the turn instead.
        if (this.interrupted.delete(task.taskId)) {
          log(`■ ${adapter.id} task interrupted; it continues after the runner restarts`);
          return resolve(false);
        }
        if (this.cancelled.delete(task.taskId)) {
          log(`■ ${adapter.id} task stopped`);
          this.send({ type: "task.done", taskId: task.taskId, ok: false, cancelled: true, result: "Stopped from Myrel." });
          return resolve(false);
        }
        log(`${ok ? "✓" : "✗"} ${adapter.id} task finished`);
        const u = usage();
        this.send({
          type: "task.done",
          taskId: task.taskId,
          ok,
          result: result.slice(0, MAX_RESULT - where.length) + where,
          ...(u && { usage: u }),
        });
        resolve(false);
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
        if (this.cancelled.has(task.taskId) || this.interrupted.has(task.taskId)) finish(false, "");
      });
      child.on("close", async (code, signal) => {
        if (buffered.trim()) adapter.line(buffered.trim(), state);
        adapter.end?.(stdout, state);
        reportLimits(state.limits ?? (await adapter.limits?.(state).catch(() => undefined)));
        const ok = code === 0 && !state.failed;
        if (resume && !ok && !state.usage && !state.progress && !this.cancelled.has(task.taskId)) {
          done = true;
          clearTimeout(timer);
          this.running.delete(task.taskId);
          // Stopping now: the new session would only be killed too.
          if (this.interrupted.has(task.taskId)) {
            this.interrupted.delete(task.taskId);
            this.worktrees.delete(task.taskId);
            this.opts.onChange?.(this.runningIds());
            void cleanup();
            return resolve(false);
          }
          return resolve(true);
        }
        // The session now holds this turn too, so the next one can continue it with only what is new.
        if (state.sessionId && RESUMES.has(task.cli)) {
          await this.opts.sessions.set(task.threadId, task.cli, { id: state.sessionId, task: task.taskId }).catch(() => {});
        }
        const result =
          state.result ??
          (ok ? stdout.trim() : `${adapter.bin} exited with ${signal ?? `code ${code}`}.\n${state.error ?? (stderr.trim() || stdout.trim())}`);
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

  /**
   * Stops every running task as this runner shuts down (an update, a restart) and returns their ids,
   * for the next runner to report as interrupted. No "task.done" is sent for them.
   */
  stopAll(): string[] {
    const ids = this.runningIds();
    for (const [taskId, child] of this.running) {
      this.interrupted.add(taskId);
      child.kill("SIGTERM");
    }
    return ids;
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
