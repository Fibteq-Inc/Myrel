import { type ArtifactRef, CLI_NAMES, createId, type ProjectWorkspace, type Task, type TaskStatus, type TerminalLine } from "@altair/protocol";
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
import { listRepoFiles, readRepoFile } from "../github/files";
import { listProjectRepos } from "../github/store";
import { projectProvider, projectTaskModel } from "../keys";
import { runLoop } from "../llm";
import { getWorkspace } from "../runners";
import { localBackend, localCanceller, normalizeRepoUrl, repoToken, sandboxBackend, taskPlace } from "../sandbox/backend";
import { threadWorkspace } from "../sandbox/workspace";
import { meteredForTurn, recordTaskUsage } from "../usage";
import { type Author, knowledgeTools } from "./knowledge";
import { THREAD_AGENT_ID, SYSTEM_ID } from "./names";
import type { ThreadWake } from "./project-agent";
import { renderTasks, type RunTaskInput, type TaskWithLog } from "./thread-tasks";
import { type CoordinatorNote, THREAD_SYSTEM, threadPrompt, threadTools } from "./thread-worker";

const BY: Author = { kind: "agent", id: THREAD_AGENT_ID };

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

/** A task's spec as stored. Tasks on the person's computer name their CLI (claude, codex…) as the harness. */
type StoredSpec = Omit<TaskSpec, "harness"> & { harness: string; runnerId?: string };

type LogRow = { stream: TerminalLine["stream"]; text: string };

/** Terminal lines kept per task; older ones are dropped. */
const MAX_LOG_LINES = 2000;
/** A task on the person's computer has no sandbox, clone or pull request steps; its CLI just works. */
const LOCAL_PHASES: RunnerEvent[] = [
  { type: "phase", phase: "prepare", state: "skipped" },
  { type: "phase", phase: "clone", state: "skipped" },
  { type: "phase", phase: "publish", state: "skipped" },
  { type: "phase", phase: "agent", state: "started" },
];
/** Extra time after a task's own timeout before it is declared lost (its runner went away). */
const WATCHDOG_GRACE_SEC = 300;

/**
 * One instance per thread (named by thread id). Runs the thread agent: each
 * wake queues a turn that reads the thread from the ProjectAgent, calls the
 * model and acts through reply / update_status / request_coordinator.
 * Messages themselves live in the ProjectAgent; this DO keeps the brief,
 * coordinator notes, a read cursor, and the tasks the agent ran (run_task in
 * the sandbox, run_local_task on the person's computer) with their progress
 * and terminal output.
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
    this.migrateLocalTasks();
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

  /** A person wrote in the thread, or the coordinator sent a note. Task results come through taskEvents. */
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
    const artifacts = await project.listArtifacts();

    const llm = await projectProvider(this.env, projectId);
    if (!llm.ok) {
      await project.sendMessage({ threadId, authorKind: "system", authorId: SYSTEM_ID, body: llm.reason });
      await project.updateThread(threadId, { status: "failed" });
      return;
    }

    const noteRows = this.sql<NoteRow>`SELECT * FROM notes ORDER BY id`;
    const notes: CoordinatorNote[] = noteRows.map((n) => ({ body: n.body, createdAt: n.created_at, isNew: n.seen === 0 }));
    const tasks = this.taskRows().map((row) => ({
      task: this.toTask(row),
      progress: JSON.parse(row.progress) as TaskProgress,
      log: row.status === "running" || row.reported ? [] : this.taskLog(row.id),
      isNew: row.status !== "running" && row.reported === 0,
    }));
    const workspace = await getWorkspace(this.env, projectId);
    const place = await taskPlace(this.env, projectId);
    const lastSeenSeq = Number(this.getMeta("last_seen_seq") ?? 0);
    this.sql`UPDATE notes SET seen = 1`;
    this.sql`UPDATE tasks SET reported = 1 WHERE status != 'running'`;
    this.setMeta("last_seen_seq", String(ctx.messages.at(-1)?.seq ?? lastSeenSeq));

    // Set from tool callbacks; typed wide so TS does not narrow them to `false`.
    let resolved: boolean = false as boolean;
    let asked: boolean = false as boolean;
    // Artifacts published this turn, attached to the next reply.
    let pending: ArtifactRef[] = [];
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
        prompt: threadPrompt({
          ...ctx,
          brief: this.getMeta("brief") ?? "",
          lastSeenSeq,
          notes,
          artifacts,
          repos: await listProjectRepos(this.env.DB, projectId),
          tasks: renderTasks(tasks),
          workspace,
          place,
        }),
        tools: [
          ...threadTools({
            reply: async (text) => {
              const artifacts = pending;
              pending = [];
              const m = await project.sendMessage({
                threadId,
                authorKind: "agent",
                authorId: THREAD_AGENT_ID,
                body: text,
                artifacts,
              });
              // Our own replies are not news on the next turn.
              this.setMeta("last_seen_seq", String(m.seq));
              return m;
            },
            publishArtifact: async (input) => {
              const result = await project.publishArtifact({ ...input, threadId });
              if ("error" in result) throw new Error(result.error);
              const { artifact } = result;
              // A second publish of the same artifact in one turn replaces its card.
              pending = [
                ...pending.filter((p) => p.artifactId !== artifact.id),
                { artifactId: artifact.id, version: artifact.version, title: artifact.title },
              ];
              return artifact;
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
            listRepoFiles: (repo, path, ref) => listRepoFiles(this.env, projectId, repo, path, ref),
            readRepoFile: (repo, path, ref) => readRepoFile(this.env, projectId, repo, path, ref),
            runTask: async (input) => {
              const started = await this.startTask(input);
              if (!started.ok) throw new Error(started.error);
              return started.message;
            },
            cancelTask: () => this.cancelRunningTask(),
          }),
          ...knowledgeTools({
            memoryRead: (name) => project.getMemory(name),
            memoryWrite: (name, description, content) => project.putMemory(name, { description, content }, BY),
            memoryDelete: (name) => project.deleteMemory(name),
            listFiles: (prefix) => project.listFiles(prefix),
            readText: (path) => project.readFileText(path),
            writeText: (path, content) => project.writeFileText(path, content, BY),
          }),
        ],
        maxSteps: 16,
      });
      // Published but never mentioned in a reply: still deliver the cards.
      if (pending.length) {
        await project.sendMessage({ threadId, authorKind: "agent", authorId: THREAD_AGENT_ID, body: "", artifacts: pending });
      }
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
      // A running task keeps the thread visibly working.
      await project.setActivity(threadId, this.runningTask() !== null);
    }
  }

  // ---- Tasks (run_task, run_local_task) -------------------------------------

  /** Starts a task for run_task or run_local_task, or says why it cannot. Callable over RPC. */
  async startTask(input: RunTaskInput): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    try {
      const { projectId } = this.ids();
      this.assertIdle();
      const place = await taskPlace(this.env, projectId);
      if (place.kind === "error") throw new Error(place.message);
      return {
        ok: true,
        message: place.kind === "local" ? await this.launchLocalTask(input, place.workspace) : await this.launchTask(input),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async launchTask(input: RunTaskInput): Promise<string> {
    const { projectId, threadId } = this.ids();
    this.assertIdle();

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
    if (spec.repo) {
      const token = await repoToken(this.env, projectId, spec.repo.url, spec.timeoutSec);
      if (token) secrets.GITHUB_TOKEN = token;
      else if (spec.openPr) {
        throw new Error("Opening a pull request needs write access to the repository. Ask the person to connect it to this project in the project's GitHub settings.");
      }
    }
    const backend = sandboxBackend(this.env, threadId);
    const unavailable = backend.unavailable(spec);
    if (unavailable) throw new Error(unavailable);
    // The sandbox's disk does not outlive it; the thread's workspace keeps the work between tasks.
    const workspace = await threadWorkspace(this.env, threadId, spec.timeoutSec + WATCHDOG_GRACE_SEC);
    if (workspace) {
      spec.workspace = { remote: workspace.remote };
      secrets.ALTAIR_WORKSPACE_TOKEN = workspace.token;
    }
    await this.launch(spec, backend.id, () => backend.start(spec, secrets), input.language);
    await this.schedule(spec.timeoutSec + WATCHDOG_GRACE_SEC, "taskWatchdog", { taskId: spec.taskId });
    return `Started "${spec.title}". Its progress shows on the thread's checklist; its result arrives in a later turn. Carry on or end your turn.`;
  }

  private async launchLocalTask(input: RunTaskInput, workspace: ProjectWorkspace): Promise<string> {
    const { projectId, threadId } = this.ids();
    const spec = TaskSpec.parse({ taskId: createId("task"), title: input.title, prompt: input.prompt });
    const backend = localBackend(this.env, { projectId, threadId, workspace });
    const unavailable = backend.unavailable(spec);
    if (unavailable) throw new Error(unavailable);
    // The person's own CLI does the work, so the task shows that CLI instead of an Altair harness.
    await this.launch(
      { ...spec, harness: workspace.cli, runnerId: workspace.runnerId },
      backend.id,
      () => backend.start(spec, {}),
      input.language,
    );
    await this.taskEvents(spec.taskId, LOCAL_PHASES);
    return `Started "${spec.title}" on the person's computer, with ${CLI_NAMES[workspace.cli]} in ${workspace.path}. Its progress shows on the thread's checklist; its result arrives in a later turn. Carry on or end your turn.`;
  }

  /** Records a task, starts it on its backend and shows it. */
  private async launch(spec: StoredSpec, backend: string, start: () => Promise<void>, language?: string) {
    // Recorded before starting: a fast task can report back before start() returns.
    this.sql`INSERT INTO tasks (id, spec, backend, status, progress, language, created_at)
      VALUES (${spec.taskId}, ${JSON.stringify(spec)}, ${backend}, ${"running"}, ${JSON.stringify(emptyProgress())},
        ${language || "en"}, ${new Date().toISOString()})`;
    await this.publishTask(spec.taskId);
    try {
      await start();
    } catch (err) {
      await this.taskEvents(spec.taskId, [
        { type: "done", ok: false, error: `Could not start: ${err instanceof Error ? err.message : String(err)}` },
      ]);
      throw err;
    }
  }

  /**
   * Progress from a runner (the sandbox, or a person's altair-runner). Callable
   * over RPC. Events after the task finished are ignored.
   */
  async taskEvents(taskId: string, events: RunnerEvent[]): Promise<void> {
    const [row] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${taskId}`;
    if (!row || row.status !== "running") return;
    const spec = JSON.parse(row.spec) as StoredSpec;

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
    try {
      await this.backendOf(row).cancel(row.id);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    return `Cancelling "${this.toTask(row).title}". Its result arrives in a later turn.`;
  }

  /** Every task in this thread with its recent terminal output. Callable over RPC. */
  getTasks(): TaskWithLog[] {
    return this.taskRows().map((row) => ({ ...this.toTask(row), log: this.taskLog(row.id, 500) }));
  }

  /** Cancels a task on a person's request. Callable over RPC. */
  async cancelTask(taskId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const row = this.runningTask();
    if (!row || row.id !== taskId) return { ok: false, error: "This task is not running." };
    try {
      await this.backendOf(row).cancel(taskId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Schedule callback: a task its runner never finished (the container went away). */
  async taskWatchdog(payload: { taskId: string }): Promise<void> {
    await this.taskEvents(payload.taskId, [
      { type: "done", ok: false, error: "The runner stopped answering, so the task was given up." },
    ]);
  }

  /** The backend a recorded task runs on, for cancelling it. */
  private backendOf(row: TaskRow): Pick<RunnerBackend, "cancel"> {
    if (row.backend === "local") return localCanceller(this.env, (JSON.parse(row.spec) as StoredSpec).runnerId);
    return sandboxBackend(this.env, this.getMeta("thread_id")!);
  }

  private ids() {
    const projectId = this.getMeta("project_id");
    const threadId = this.getMeta("thread_id");
    if (!projectId || !threadId) throw new Error("This thread is not set up yet.");
    return { projectId, threadId };
  }

  private assertIdle() {
    const running = this.runningTask();
    if (running) {
      throw new Error(`"${this.toTask(running).title}" is still running. Wait for its result, or cancel it with cancel_task.`);
    }
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
    const spec = JSON.parse(row.spec) as StoredSpec;
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

  /**
   * Threads that ran tasks on a person's computer before tasks were unified
   * kept them in an older `tasks` table. Moves them into the current one.
   */
  private migrateLocalTasks() {
    const columns = this.sql<{ name: string }>`PRAGMA table_info(tasks)`;
    if (!columns.some((c) => c.name === "runner_id")) return;
    type OldRow = { id: string; runner_id: string; prompt: string; status: TaskStatus; result: string | null; created_at: string; seen: number };
    const old = this.sql<OldRow>`SELECT * FROM tasks`;
    this.sql`DROP TABLE tasks`;
    this.sql`CREATE TABLE tasks (
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
    for (const t of old) {
      const title = t.prompt.split("\n")[0]!.slice(0, 80) || "Task";
      const spec = { taskId: t.id, title, prompt: t.prompt, harness: "cli", runnerId: t.runner_id, openPr: false, timeoutSec: 1800 };
      const finished = t.status === "running" ? null : { ok: t.status === "done" };
      const progress = [...LOCAL_PHASES, ...(finished ? [{ type: "done" as const, ...finished }] : [])].reduce(reduceTask, {
        ...emptyProgress(),
        lastText: t.result,
      });
      this.sql`INSERT INTO tasks (id, spec, backend, status, progress, summary, created_at, reported)
        VALUES (${t.id}, ${JSON.stringify(spec)}, ${"local"}, ${t.status}, ${JSON.stringify(progress)}, ${t.result},
          ${t.created_at}, ${t.seen})`;
    }
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
