import { createId, type Task, type TaskStatus, type TerminalLine } from "@altair/protocol";
import {
  emptyProgress,
  HarnessId,
  reduceTask,
  renderChecklist,
  type RunnerBackend,
  type RunnerEvent,
  type TaskProgress,
  TaskSpec,
} from "@altair/runner-core";
import { Agent, getAgentByName } from "agents";
import { projectProvider, projectTaskModel } from "../keys";
import { runLoop } from "../llm";
import { normalizeRepoUrl, repoToken, sandboxBackend } from "../sandbox/backend";
import { meteredForTurn, recordTaskUsage } from "../usage";
import { THREAD_AGENT_ID, SYSTEM_ID } from "./names";
import type { ThreadWake } from "./project-agent";
import { renderTasks, type RunTaskInput, type TaskWithLog } from "./thread-tasks";
import { type CoordinatorNote, THREAD_SYSTEM, threadPrompt, threadTools } from "./thread-worker";

export type ThreadStart = { projectId: string; threadId: string; brief: string };

type NoteRow = { id: number; body: string; created_at: string; seen: number };

type TaskRow = {
  id: string;
  spec: string;
  backend: string;
  status: TaskStatus;
  progress: string;
  summary: string | null;
  pr_url: string | null;
  language: string;
  created_at: string;
  finished_at: string | null;
  reported: number;
};

type LogRow = { stream: TerminalLine["stream"]; text: string };

/** Terminal lines kept per task; older ones are dropped. */
const MAX_LOG_LINES = 2000;
/** Extra time after a task's own timeout before it is declared lost (its runner went away). */
const WATCHDOG_GRACE_SEC = 300;

/**
 * One instance per thread (named by thread id). Runs the thread agent: each
 * wake queues a turn that reads the thread from the ProjectAgent, calls the
 * model and acts through reply / update_status / request_coordinator.
 * Messages themselves live in the ProjectAgent; this DO keeps the brief,
 * coordinator notes, a read cursor, and the tasks the agent ran with
 * run_task (their progress and terminal output).
 */
export class ThreadAgent extends Agent<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      spec TEXT NOT NULL,
      backend TEXT NOT NULL,
      status TEXT NOT NULL,
      progress TEXT NOT NULL,
      summary TEXT,
      pr_url TEXT,
      language TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL,
      finished_at TEXT,
      reported INTEGER NOT NULL DEFAULT 0
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS task_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      text TEXT NOT NULL
    )`;
  }

  /** Called by the ProjectAgent when the coordinator opens this thread. */
  async start(input: ThreadStart): Promise<void> {
    this.setMeta("project_id", input.projectId);
    this.setMeta("thread_id", input.threadId);
    this.setMeta("brief", input.brief);
    await this.markDirty();
  }

  /** A person wrote in the thread, or the coordinator sent a note. */
  async wake(reason: ThreadWake): Promise<void> {
    if (reason.kind === "coordinator") {
      this.sql`INSERT INTO notes (body, created_at) VALUES (${reason.note}, ${new Date().toISOString()})`;
    }
    await this.markDirty();
  }

  private async markDirty() {
    this.setMeta("dirty", "1");
    await this.queue("threadTurn", null);
  }

  /** Queue callback. Turns run one at a time; wakes during a turn get their own turn after it. */
  async threadTurn(): Promise<void> {
    if (this.getMeta("dirty") !== "1") return;
    this.setMeta("dirty", "0");
    const projectId = this.getMeta("project_id");
    const threadId = this.getMeta("thread_id");
    if (!projectId || !threadId) return;

    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const ctx = await project.getThreadContext(threadId);
    if (!ctx) return;

    const llm = await projectProvider(this.env, projectId);
    if (!llm.ok) {
      await project.sendMessage({ threadId, authorKind: "system", authorId: SYSTEM_ID, body: llm.reason });
      await project.updateThread(threadId, { status: "failed" });
      return;
    }

    const noteRows = this.sql<NoteRow>`SELECT * FROM notes ORDER BY id`;
    const notes: CoordinatorNote[] = noteRows.map((n) => ({ body: n.body, createdAt: n.created_at, isNew: n.seen === 0 }));
    const lastSeenSeq = Number(this.getMeta("last_seen_seq") ?? 0);
    const tasks = this.taskRows().map((row) => ({
      task: this.toTask(row),
      progress: JSON.parse(row.progress) as TaskProgress,
      log: row.status === "running" || row.reported ? [] : this.taskLog(row.id),
      isNew: row.status !== "running" && row.reported === 0,
    }));
    this.sql`UPDATE notes SET seen = 1`;
    this.sql`UPDATE tasks SET reported = 1 WHERE status != 'running'`;
    this.setMeta("last_seen_seq", String(ctx.messages.at(-1)?.seq ?? lastSeenSeq));

    // Set from tool callbacks; typed wide so TS does not narrow them to `false`.
    let resolved: boolean = false as boolean;
    let asked: boolean = false as boolean;
    await project.updateThread(threadId, { status: "working" });
    await project.setActivity(threadId, true);
    try {
      // Bill the turn to the newest person in the thread, else whoever asked in the root message.
      const requester = [...ctx.messages].reverse().find((m) => m.authorKind === "user") ?? ctx.root;
      await runLoop({
        provider: meteredForTurn(llm.provider, this.env, {
          projectId,
          threadId,
          userId: requester.authorKind === "user" ? requester.authorId : null,
          agent: "thread",
        }),
        system: THREAD_SYSTEM,
        prompt: threadPrompt({ ...ctx, brief: this.getMeta("brief") ?? "", lastSeenSeq, notes, tasks: renderTasks(tasks) }),
        tools: threadTools({
          reply: async (text) => {
            const m = await project.sendMessage({ threadId, authorKind: "agent", authorId: THREAD_AGENT_ID, body: text });
            // Our own replies are not news on the next turn.
            this.setMeta("last_seen_seq", String(m.seq));
            return m;
          },
          setStatusText: async (text) => {
            await project.updateThread(threadId, { statusText: text });
          },
          requestCoordinator: async (kind, reason) => {
            asked = true;
            await project.requestCoordinator(threadId, kind, reason);
          },
          resolve: async () => {
            resolved = true;
          },
          runTask: async (input) => {
            const started = await this.startTask(input);
            if (!started.ok) throw new Error(started.error);
            return started.message;
          },
          cancelTask: () => this.cancelRunningTask(),
        }),
        maxSteps: 12,
      });
      const running = this.runningTask() !== null;
      await project.updateThread(threadId, {
        status: running ? "working" : resolved ? "done" : asked ? "blocked" : "review_ready",
        resolved: resolved && !running,
      });
    } catch (err) {
      console.error("thread turn failed", err);
      await project.sendMessage({
        threadId,
        authorKind: "system",
        authorId: SYSTEM_ID,
        body: `This thread's turn failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      await project.updateThread(threadId, { status: "failed" });
    } finally {
      await project.setActivity(threadId, false);
    }
  }

  // ---- Tasks (run_task) --------------------------------------------------

  /** Starts a task for the run_task tool, or says why it cannot. Callable over RPC. */
  async startTask(input: RunTaskInput): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    try {
      return { ok: true, message: await this.launchTask(input) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async launchTask(input: RunTaskInput): Promise<string> {
    const projectId = this.getMeta("project_id");
    const threadId = this.getMeta("thread_id");
    if (!projectId || !threadId) throw new Error("This thread is not set up yet.");
    const running = this.runningTask();
    if (running) {
      throw new Error(`"${this.toTask(running).title}" is still running. Wait for its result, or cancel it with cancel_task.`);
    }

    const harness = HarnessId.catch("opencode").parse(input.harness ?? this.env.RUNNER_HARNESS);
    const secrets: Record<string, string> = {};
    let model: TaskSpec["model"];
    if (harness !== "shell") {
      const m = await projectTaskModel(this.env, projectId);
      if (!m.ok) throw new Error(m.reason);
      if (harness === "claude-code" && m.model.kind !== "anthropic") {
        throw new Error("Claude Code needs an Anthropic model, and this server uses another provider. Use opencode.");
      }
      model = m.model;
      secrets.ALTAIR_MODEL_API_KEY = m.apiKey;
      if (harness === "claude-code") secrets.ANTHROPIC_API_KEY = m.apiKey;
    }

    let repo: TaskSpec["repo"];
    if (input.repo) {
      const url = normalizeRepoUrl(input.repo);
      if (!url) throw new Error(`"${input.repo}" is not a repository I can clone. Use owner/name or an https URL.`);
      repo = { url, branch: input.branch || undefined, baseBranch: input.baseBranch || undefined };
      const token = await repoToken(this.env, projectId, url);
      if (token) secrets.GITHUB_TOKEN = token;
      else if (input.openPr) {
        throw new Error("Opening a pull request needs write access to the repository. Ask the person to connect it to this project in the project's GitHub settings.");
      }
    } else if (input.openPr) {
      throw new Error("open_pr needs a repo.");
    }

    const spec = TaskSpec.parse({
      taskId: createId("task"),
      title: input.title,
      prompt: input.prompt,
      harness,
      repo,
      openPr: input.openPr ?? false,
      model,
    });
    const backend = this.backendFor(threadId);
    const unavailable = backend.unavailable(spec);
    if (unavailable) throw new Error(unavailable);

    const now = new Date().toISOString();
    this.sql`INSERT INTO tasks (id, spec, backend, status, progress, language, created_at)
      VALUES (${spec.taskId}, ${JSON.stringify(spec)}, ${backend.id}, ${"running"}, ${JSON.stringify(emptyProgress())},
        ${input.language || "en"}, ${now})`;
    await this.publishTask(spec.taskId);
    try {
      await backend.start(spec, secrets);
    } catch (err) {
      await this.taskEvents(spec.taskId, [
        { type: "done", ok: false, error: `Could not start: ${err instanceof Error ? err.message : String(err)}` },
      ]);
      throw err;
    }
    await this.schedule(spec.timeoutSec + WATCHDOG_GRACE_SEC, "taskWatchdog", { taskId: spec.taskId });
    return `Started "${spec.title}". Its progress shows on the thread's checklist; its result arrives in a later turn. Carry on or end your turn.`;
  }

  /**
   * Progress from a runner (the sandbox, or a person's altair-runner). Callable
   * over RPC. Events after the task finished are ignored.
   */
  async taskEvents(taskId: string, events: RunnerEvent[]): Promise<void> {
    const [row] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${taskId}`;
    if (!row || row.status !== "running") return;
    const spec = JSON.parse(row.spec) as TaskSpec;

    const lines: TerminalLine[] = [];
    let progress = JSON.parse(row.progress) as TaskProgress;
    for (const e of events) {
      progress = reduceTask(progress, e);
      if (e.type === "log") lines.push({ stream: e.stream, text: e.text });
      else if (e.type === "tool") lines.push({ stream: "system", text: `→ ${e.title}` });
      else if (e.type === "phase" && e.state === "failed") lines.push({ stream: "stderr", text: e.detail ?? `${e.phase} failed` });
      else if (e.type === "pr") lines.push({ stream: "system", text: `Pull request: ${e.url}` });
    }
    for (const l of lines) this.sql`INSERT INTO task_log (task_id, stream, text) VALUES (${taskId}, ${l.stream}, ${l.text})`;
    if (lines.length) {
      this.sql`DELETE FROM task_log WHERE task_id = ${taskId} AND id <= (
        SELECT id FROM task_log WHERE task_id = ${taskId} ORDER BY id DESC LIMIT 1 OFFSET ${MAX_LOG_LINES})`;
    }

    const finished = progress.finished;
    const status: TaskStatus = !finished
      ? "running"
      : finished.ok
        ? "done"
        : finished.error === "Cancelled."
          ? "cancelled"
          : "failed";
    const summary = finished
      ? finished.ok
        ? progress.lastText
        : [finished.error, progress.lastText].filter(Boolean).join("\n\n") || null
      : null;
    this.sql`UPDATE tasks SET progress = ${JSON.stringify(progress)}, status = ${status}, summary = ${summary},
      pr_url = ${progress.prUrl}, finished_at = ${finished ? new Date().toISOString() : null} WHERE id = ${taskId}`;

    const projectId = this.getMeta("project_id");
    const threadId = this.getMeta("thread_id");
    if (!projectId || !threadId) return;
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    if (lines.length) await project.broadcastTask({ type: "task.output", taskId, threadId, lines });
    await project.updateThread(threadId, { statusText: renderChecklist(spec.title, progress, row.language) });
    if (finished) {
      if (spec.model) {
        const ctx = { projectId, threadId, taskId, provider: spec.model.provider, model: spec.model.id };
        const ms = Date.now() - Date.parse(row.created_at);
        await recordTaskUsage(this.env, ctx, progress.usage, ms).catch((err) => console.error("task usage", err));
      }
      await this.publishTask(taskId);
      // The agent reads the result and tells the person.
      await this.markDirty();
    }
  }

  /** Stops the running task. Returns what the model is told. */
  async cancelRunningTask(): Promise<string> {
    const row = this.runningTask();
    if (!row) return "No task is running.";
    const threadId = this.getMeta("thread_id")!;
    await this.backendFor(threadId).cancel(row.id);
    return `Cancelling "${this.toTask(row).title}". Its result arrives in a later turn.`;
  }

  /** Every task in this thread with its recent terminal output. Callable over RPC. */
  getTasks(): TaskWithLog[] {
    return this.taskRows().map((row) => ({ ...this.toTask(row), log: this.taskLog(row.id, 500) }));
  }

  /** Cancels a task on a person's request. Callable over RPC. */
  async cancelTask(taskId: string): Promise<boolean> {
    const row = this.runningTask();
    if (!row || row.id !== taskId) return false;
    await this.backendFor(this.getMeta("thread_id")!).cancel(taskId);
    return true;
  }

  /** Schedule callback: a task its runner never finished (the container went away). */
  async taskWatchdog(payload: { taskId: string }): Promise<void> {
    await this.taskEvents(payload.taskId, [
      { type: "done", ok: false, error: "The runner stopped answering, so the task was given up." },
    ]);
  }

  /** Where tasks run. The local altair-runner adds its backend here. */
  private backendFor(threadId: string): RunnerBackend {
    return sandboxBackend(this.env, threadId);
  }

  private async publishTask(taskId: string) {
    const [row] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${taskId}`;
    const projectId = this.getMeta("project_id");
    if (!row || !projectId) return;
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    await project.broadcastTask({ type: "task.updated", task: this.toTask(row) });
  }

  private runningTask(): TaskRow | null {
    const [row] = this.sql<TaskRow>`SELECT * FROM tasks WHERE status = 'running' LIMIT 1`;
    return row ?? null;
  }

  private taskRows(): TaskRow[] {
    return this.sql<TaskRow>`SELECT * FROM tasks ORDER BY created_at`;
  }

  private taskLog(taskId: string, limit = MAX_LOG_LINES): TerminalLine[] {
    return this.sql<LogRow>`SELECT stream, text FROM task_log WHERE task_id = ${taskId} ORDER BY id DESC LIMIT ${limit}`
      .reverse()
      .map((r) => ({ stream: r.stream, text: r.text }));
  }

  private toTask(row: TaskRow): Task {
    const spec = JSON.parse(row.spec) as TaskSpec;
    return {
      id: row.id,
      threadId: this.getMeta("thread_id") ?? "",
      title: spec.title,
      harness: spec.harness,
      backend: row.backend,
      status: row.status,
      prUrl: row.pr_url,
      summary: row.summary,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    };
  }

  private getMeta(key: string): string | null {
    const [row] = this.sql<{ value: string }>`SELECT value FROM meta WHERE key = ${key}`;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string) {
    this.sql`INSERT INTO meta (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  }
}
