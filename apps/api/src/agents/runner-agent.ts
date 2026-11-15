import { createDb, schema } from "@myrel/db";
import {
  type AgentStart,
  type TaskGithub,
  type TaskModel,
  type CliId,
  RUNNER_PROTOCOL_VERSION,
  type RunnerDirListing,
  type RunnerFeature,
  type RunnerFile,
  type RunnerFolder,
  type RunnerInfo,
  type RunnerSettings,
  type RunnerSettingsInput,
  type RunnerStats,
  RunnerToServer,
  type RunnerUpdateState,
  ServerToRunner,
  SSH_TIMEOUT_MS,
  type SshHostKey,
  type SshKeyRef,
  type SshLocalKey,
  type SshResult,
  type SshTarget,
} from "@myrel/protocol";
import { Agent, type Connection, type ConnectionContext, getAgentByName } from "agents";
import { eq } from "drizzle-orm";
import { notifyRunnerProjects, parseInfo, RUNNER_ID_HEADER } from "../runners";
import { FLAP_MAX_CONNECTS, FLAP_WINDOW_MS } from "./auto-resume";

export type TaskStart = {
  taskId: string;
  projectId: string;
  threadId: string;
  folder: string;
  /** The project's other folders on this computer. */
  folders?: string[];
  cli: CliId;
  prompt: string;
  /** The CLI runs as the thread's agent, connected to the thread's MCP endpoint (needs feature "agent"). */
  agent?: AgentStart;
  /** The model and effort, only ever ones the runner listed (so only runners with feature "models"). */
  model?: TaskModel;
  /** The turn's GitHub token (only runners with feature "git-token"). Never stored or logged here. */
  github?: TaskGithub;
  /** The CLI's other login to run with, only one the runner listed (so only runners with feature "cli-accounts"). */
  account?: string;
  /**
   * The CLI works in `folder` itself, not in a worktree of it (the project's setting, ProjectSettings.worktrees;
   * only runners with feature "shared-folder"): one such turn of the project at a time, see claimFolder.
   */
  shared?: boolean;
  /**
   * The CLI works as the project's coordinator for one turn (only runners with feature "coordinator"):
   * what it reports goes to the project, not to a thread (`threadId` is a fresh id nothing uses).
   */
  coordinator?: { system: string };
};
export type TaskStartResult = { ok: true } | { ok: false; reason: string };
/** A thread's turn may work in the project's shared folder now, or waits for `busy`, the thread working there. */
export type FolderClaim = { ok: true } | { ok: false; busy: string };
export type RunnerResult<T> = ({ ok: true } & T) | { ok: false; reason: string };

/** How long the web app waits for the computer to answer a folder request. */
const REQUEST_TIMEOUT_MS = 15_000;
/** How long a thread's claim on a project's shared folder holds before its task starts (see claimFolder). */
const CLAIM_MS = 2 * 60_000;

type Answer = Extract<RunnerToServer, { requestId: string }>;
type Question = Extract<ServerToRunner, { requestId: string }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type TaskRow = {
  id: string;
  project_id: string;
  thread_id: string;
  status: "running" | "done" | "failed";
  /** 1: it works in the project's folder itself (TaskStart.shared). */
  shared: number;
  /** 1: a turn of the project's coordinator (TaskStart.coordinator), reported to the project. */
  coordinator: number;
};

/**
 * One instance per paired computer (named by runner id). Holds the runner's
 * outbound WebSocket, hands it tasks from thread agents and sends each
 * result back to the thread that asked. The runner only ever receives a
 * folder, a CLI name and a prompt; its CLI logins never leave the computer.
 */
export class RunnerAgent extends Agent<Env> {
  static override options = { sendIdentityOnConnect: false };

  /** Folder requests waiting for the computer's answer. In memory: they only live for a few seconds. */
  private readonly waiting = new Map<string, (answer: Answer) => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
    // Added with projects whose threads work in their folder itself (TaskStart.shared).
    if (!this.sql<{ name: string }>`PRAGMA table_info(tasks)`.some((c) => c.name === "shared")) {
      this.sql`ALTER TABLE tasks ADD COLUMN shared INTEGER NOT NULL DEFAULT 0`;
    }
    // Added with the coordinator working on a member's CLI (TaskStart.coordinator).
    if (!this.sql<{ name: string }>`PRAGMA table_info(tasks)`.some((c) => c.name === "coordinator")) {
      this.sql`ALTER TABLE tasks ADD COLUMN coordinator INTEGER NOT NULL DEFAULT 0`;
    }
    // A thread about to start a turn in a project's shared folder, and threads waiting for it (see claimFolder).
    this.sql`CREATE TABLE IF NOT EXISTS folder_claims (
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (project_id, thread_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS folder_waits (
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (project_id, thread_id)
    )`;
    // When the computer connected lately, to tell a runner that keeps going down from one restart.
    this.sql`CREATE TABLE IF NOT EXISTS connects (at INTEGER NOT NULL)`;
    // The computer's latest measurement (feature "stats"): one row, kept only while it is connected.
    this.sql`CREATE TABLE IF NOT EXISTS stats (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`;
  }

  override shouldSendProtocolMessages(): boolean {
    return false;
  }

  /** The runner never writes the agent's synced state: its frames go through onMessage. */
  override shouldConnectionBeReadonly(): boolean {
    return true;
  }

  override async onConnect(connection: Connection, { request }: ConnectionContext) {
    if (request.headers.get(RUNNER_ID_HEADER) !== this.name) {
      connection.close(4401, "unauthorized");
      return;
    }
    // One live connection per runner: a second `myrel-runner start` replaces the first.
    for (const other of this.getConnections()) {
      if (other.id !== connection.id) other.close(4000, "replaced by a newer connection");
    }
    const now = Date.now();
    this.sql`DELETE FROM connects WHERE at < ${now - FLAP_WINDOW_MS}`;
    this.sql`INSERT INTO connects (at) VALUES (${now})`;
    const [row] = await createDb(this.env.DB)
      .select({ name: schema.runners.name })
      .from(schema.runners)
      .where(eq(schema.runners.id, this.name));
    send(connection, { type: "welcome", runnerId: this.name, name: row?.name ?? "" });
  }

  override async onMessage(connection: Connection, raw: string | ArrayBuffer | ArrayBufferView) {
    let data: unknown;
    try {
      data = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    const parsed = RunnerToServer.safeParse(data);
    if (!parsed.success) return;
    const frame = parsed.data;

    switch (frame.type) {
      case "ping":
        if (frame.stats) this.saveStats(frame.stats);
        return send(connection, { type: "pong" });
      case "hello": {
        if (frame.protocol !== RUNNER_PROTOCOL_VERSION) {
          connection.close(4400, `unsupported runner protocol ${frame.protocol}; update myrel-runner`);
          return;
        }
        const { type: _t, protocol: _p, running, interrupted, stats, ...info } = frame;
        this.saveStats(stats);
        await createDb(this.env.DB)
          .update(schema.runners)
          .set({ info: JSON.stringify(info), lastSeenAt: new Date() })
          .where(eq(schema.runners.id, this.name));
        // Tasks we think are running but the computer no longer knows about died with it (its runner
        // restarted, or the computer went away): their threads continue them, within limits.
        const alive = new Set(running);
        const restarted = new Set(interrupted);
        const [recent] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM connects WHERE at >= ${Date.now() - FLAP_WINDOW_MS}`;
        for (const task of this.sql<TaskRow>`SELECT * FROM tasks WHERE status = 'running'`) {
          if (alive.has(task.id)) continue;
          if (task.coordinator) {
            // A coordinator turn is not continued: the server's model takes it if it changed nothing yet.
            await (await this.project(task)).coordinatorTaskDone(task.id, { ok: false, result: "The computer's runner restarted." });
            this.sql`UPDATE tasks SET status = 'failed' WHERE id = ${task.id}`;
            continue;
          }
          const thread = await getAgentByName(this.env.THREAD_AGENT, task.thread_id);
          await thread.taskInterrupted(task.id, { restarted: restarted.has(task.id), flapping: (recent?.n ?? 0) > FLAP_MAX_CONNECTS });
          this.sql`UPDATE tasks SET status = 'failed' WHERE id = ${task.id}`;
        }
        await notifyRunnerProjects(this.env, this.name);
        return;
      }
      case "task.progress": {
        const [task] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${frame.taskId}`;
        if (task?.status !== "running") return;
        // A coordinator turn's steps are its tool calls, which people see as they happen.
        if (task.coordinator) {
          if (frame.usage) (await this.project(task)).coordinatorCliUsage(task.id, frame.usage);
          return;
        }
        const thread = await getAgentByName(this.env.THREAD_AGENT, task.thread_id);
        if (frame.usage) await thread.cliUsage(task.id, frame.usage);
        // Empty text: only the usage changed (a subagent starting or ending may have none).
        if (!frame.text && !frame.agent?.state) return;
        const project = await getAgentByName(this.env.PROJECT_AGENT, task.project_id);
        // The activity line takes the step's first line, after the subagent's name when it is one's;
        // the terminal keeps all of it (an agent's message, a long command).
        const first = frame.text.trim().split("\n")[0]!;
        const activity = frame.agent ? [frame.agent.label, first].filter(Boolean).join(": ") : first;
        if (activity) await project.setActivity(task.thread_id, true, activity.slice(0, 200));
        const step = { type: "tool", name: "cli", title: frame.text.trim() } as const;
        await thread.taskEvents(task.id, [{ ...step, ...(frame.agent && { agent: frame.agent }), ...(frame.ms !== undefined && { ms: frame.ms }) }]);
        return;
      }
      case "task.folders": {
        const [task] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${frame.taskId}`;
        if (task?.status !== "running" || task.coordinator) return;
        await (await getAgentByName(this.env.THREAD_AGENT, task.thread_id)).agentFolders(task.id, frame.folders);
        return;
      }
      case "task.done": {
        const [task] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${frame.taskId}`;
        if (task?.status !== "running") return;
        if (task.coordinator) {
          const project = await this.project(task);
          if (frame.usage) await project.coordinatorCliUsage(task.id, frame.usage);
          await project.coordinatorTaskDone(task.id, { ok: frame.ok, result: frame.result });
          this.sql`UPDATE tasks SET status = ${frame.ok ? "done" : "failed"} WHERE id = ${task.id}`;
          return;
        }
        if (frame.usage) await (await getAgentByName(this.env.THREAD_AGENT, task.thread_id)).cliUsage(task.id, frame.usage);
        await this.finish(task, frame.ok, frame.result, frame.cancelled);
        return;
      }
      case "folders":
        // Saved now, so the web app sees the change as soon as its request returns.
        await this.saveInfo({ folders: frame.folders });
        this.waiting.get(frame.requestId)?.(frame);
        return;
      case "settings":
        await this.saveInfo({ settings: frame.settings });
        this.waiting.get(frame.requestId)?.(frame);
        return;
      case "update.accepted":
        await this.saveInfo({ update: frame.update });
        this.waiting.get(frame.requestId)?.(frame);
        return;
      case "update.status":
        await this.saveInfo({ update: frame.update ?? undefined });
        return;
      case "dirs":
      case "task.steered":
      case "ssh.key":
      case "ssh.keylist":
      case "ssh.hostkeylist":
      case "ssh.result":
      case "request.failed":
        this.waiting.get(frame.requestId)?.(frame);
        return;
    }
  }

  override async onClose(connection: Connection) {
    const others = [...this.getConnections()].filter((c) => c.id !== connection.id);
    if (others.length > 0) return;
    this.saveStats(undefined);
    await createDb(this.env.DB)
      .update(schema.runners)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.runners.id, this.name));
    await notifyRunnerProjects(this.env, this.name);
  }

  /** Whether the computer is connected right now. Callable over RPC. */
  isOnline(): boolean {
    for (const _ of this.getConnections()) return true;
    return false;
  }

  /** Whether the computer is connected, and how busy it is when its runner says. Callable over RPC. */
  presence(): { online: boolean; stats: RunnerStats | null } {
    const online = this.isOnline();
    if (!online) return { online, stats: null };
    const [row] = this.sql<{ json: string }>`SELECT json FROM stats WHERE id = 1`;
    return { online, stats: row ? (JSON.parse(row.json) as RunnerStats) : null };
  }

  /**
   * Keeps the latest measurement, or forgets it. In the object's own storage rather than memory: the
   * object may be evicted between two pings while the WebSocket stays open.
   */
  private saveStats(stats: RunnerStats | undefined) {
    if (stats) this.sql`INSERT OR REPLACE INTO stats (id, json) VALUES (1, ${JSON.stringify(stats)})`;
    else this.sql`DELETE FROM stats WHERE id = 1`;
  }

  /** Sends a task to the computer. Callable over RPC by thread agents. */
  startTask(input: TaskStart): TaskStartResult {
    const connection = this.getConnections()[Symbol.iterator]().next().value as Connection | undefined;
    if (!connection) return { ok: false, reason: "The computer is offline. Ask the person to run `myrel-runner start` on it." };
    const { taskId } = input;
    const frame: ServerToRunner = {
      type: "task.start",
      taskId,
      threadId: input.threadId,
      folder: input.folder,
      ...(input.folders?.length && { folders: input.folders }),
      ...(input.shared && { worktree: false }),
      cli: input.cli,
      prompt: input.prompt,
      ...(input.agent && { agent: input.agent }),
      ...(input.model && { model: input.model }),
      ...(input.github && { github: input.github }),
      ...(input.account && { account: input.account }),
      ...(input.coordinator && { coordinator: input.coordinator }),
    };
    // A runner drops a frame it cannot read, and the task would then wait for output forever.
    const checked = ServerToRunner.safeParse(frame);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      console.error("task.start does not fit the runner protocol", taskId, issue?.path.join("."), issue?.message);
      return { ok: false, reason: `Myrel could not send this task to the computer (${issue?.path.join(".") || "frame"}: ${issue?.message ?? "invalid"}).` };
    }
    if (input.shared) {
      // claimFolder said it may; a turn of another thread that started meanwhile still comes first.
      if (this.sharedRunning(input.projectId, input.threadId)) {
        return { ok: false, reason: "Another thread of this project is working in its folder on this computer right now. Write here again once it is done." };
      }
      this.sql`DELETE FROM folder_claims WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}`;
    }
    this.sql`INSERT INTO tasks (id, project_id, thread_id, status, created_at, shared, coordinator)
      VALUES (${taskId}, ${input.projectId}, ${input.threadId}, 'running', ${new Date().toISOString()}, ${input.shared ? 1 : 0}, ${input.coordinator ? 1 : 0})`;
    send(connection, frame);
    return { ok: true };
  }

  /**
   * Whether a thread's turn may work in its project's folder on this computer now, for a project whose
   * threads work in the folder itself (ProjectSettings.worktrees off): one turn of the project at a time,
   * so two CLIs never change the same files or run git at once. The first to ask holds the folder for
   * CLAIM_MS until its task starts (startTask with `shared`); while another thread's turn works there,
   * the answer names that thread and this one is noted as waiting, to be woken when it ends (releaseFolder).
   * A turn its thread already gave up (its watchdog, say) without the computer's word does not count.
   * Callable over RPC by thread agents.
   */
  async claimFolder(projectId: string, threadId: string): Promise<FolderClaim> {
    for (const task of this.sql<TaskRow>`SELECT * FROM tasks
      WHERE project_id = ${projectId} AND status = 'running' AND shared = 1 AND thread_id != ${threadId}`) {
      const thread = await getAgentByName(this.env.THREAD_AGENT, task.thread_id);
      if (await thread.runsTask(task.id).catch(() => true)) return this.waitForFolder(projectId, threadId, task.thread_id);
      this.sql`UPDATE tasks SET status = 'failed' WHERE id = ${task.id} AND status = 'running'`;
    }
    // From here on nothing waits, so no other claim can come in between the look and the claim.
    const now = Date.now();
    this.sql`DELETE FROM folder_claims WHERE at < ${now - CLAIM_MS}`;
    const [held] = this.sql<{ thread_id: string }>`SELECT thread_id FROM folder_claims
      WHERE project_id = ${projectId} AND thread_id != ${threadId} ORDER BY at LIMIT 1`;
    const busy = held?.thread_id ?? this.sharedRunning(projectId, threadId);
    if (busy) return this.waitForFolder(projectId, threadId, busy);
    this.sql`INSERT OR REPLACE INTO folder_claims (project_id, thread_id, at) VALUES (${projectId}, ${threadId}, ${now})`;
    this.sql`DELETE FROM folder_waits WHERE project_id = ${projectId} AND thread_id = ${threadId}`;
    return { ok: true };
  }

  /**
   * A thread's turn in its project's shared folder ended, or never started: the folder is free for the
   * thread that has waited longest, which is woken (the first one that still wants its turn). Callable
   * over RPC by thread agents.
   */
  async releaseFolder(projectId: string, threadId: string): Promise<void> {
    this.sql`DELETE FROM folder_claims WHERE project_id = ${projectId} AND thread_id = ${threadId}`;
    for (const next of this.sql<{ thread_id: string }>`SELECT thread_id FROM folder_waits WHERE project_id = ${projectId} ORDER BY at`) {
      this.sql`DELETE FROM folder_waits WHERE project_id = ${projectId} AND thread_id = ${next.thread_id}`;
      const thread = await getAgentByName(this.env.THREAD_AGENT, next.thread_id);
      if (await thread.folderFree().catch(() => false)) return;
    }
  }

  /** The thread whose turn works in the project's shared folder here now, other than `threadId`, if any. */
  private sharedRunning(projectId: string, threadId: string): string | null {
    const [row] = this.sql<{ thread_id: string }>`SELECT thread_id FROM tasks
      WHERE project_id = ${projectId} AND status = 'running' AND shared = 1 AND thread_id != ${threadId} LIMIT 1`;
    return row?.thread_id ?? null;
  }

  private waitForFolder(projectId: string, threadId: string, busy: string): FolderClaim {
    this.sql`INSERT OR IGNORE INTO folder_waits (project_id, thread_id, at) VALUES (${projectId}, ${threadId}, ${Date.now()})`;
    return { ok: false, busy };
  }

  /** Hands a running task a new GitHub token before its last one expires. Callable over RPC by thread agents. */
  renewGithub(taskId: string, github: TaskGithub): TaskStartResult {
    const [task] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${taskId}`;
    if (task?.status !== "running") return { ok: false, reason: "This task is not running." };
    const [connection] = this.getConnections();
    if (!connection) return { ok: false, reason: "The computer is offline." };
    send(connection, { type: "task.github", taskId, github });
    return { ok: true };
  }

  /**
   * Hands people's new messages to a running task's CLI mid-turn (feature "steer"). True once the CLI
   * took them; false when it cannot (another CLI, an older runner, the turn just ended). feature: the one
   * the task's CLI needs ("steer-claude" for Claude Code). Callable over RPC.
   */
  async steerTask(taskId: string, text: string, feature: RunnerFeature = "steer"): Promise<boolean> {
    const [task] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${taskId}`;
    if (task?.status !== "running") return false;
    const answer = await this.ask({ type: "task.steer", taskId, text }, feature);
    return answer.ok !== false && answer.type === "task.steered" && answer.taken;
  }

  /** Asks the computer to stop a task; its result arrives as a cancelled "task.done". Callable over RPC. */
  async cancelTask(taskId: string): Promise<TaskStartResult> {
    const [task] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${taskId}`;
    if (task?.status !== "running") return { ok: false, reason: "This task is not running." };
    const [connection] = this.getConnections();
    if (!connection) return { ok: false, reason: "The computer is offline, so the task cannot be stopped from here." };
    const [row] = await createDb(this.env.DB)
      .select({ info: schema.runners.info })
      .from(schema.runners)
      .where(eq(schema.runners.id, this.name));
    if (!parseInfo(row?.info ?? null)?.features.includes("cancel")) {
      return { ok: false, reason: "Update myrel-runner on this computer to stop tasks from Myrel (npx myrel-runner@latest)." };
    }
    send(connection, { type: "task.cancel", taskId });
    return { ok: true };
  }

  /** The folders inside `path` on the computer (its home folder when absent). Callable over RPC. */
  async listDirs(path?: string): Promise<RunnerResult<{ listing: RunnerDirListing }>> {
    const answer = await this.ask({ type: "dirs.list", path });
    if (answer.ok === false) return answer;
    if (answer.type !== "dirs") return { ok: false, reason: "Unexpected answer from the computer." };
    const { type: _t, requestId: _r, ...listing } = answer;
    return { ok: true, listing };
  }

  /**
   * One file in a project's folders (`folders`, each shared on the computer) or in the thread's
   * worktree of them, e.g. one an agent's message links to. Callable over RPC.
   */
  async readFile(input: { path: string; folders: string[]; threadId?: string; worktrees?: boolean }): Promise<RunnerResult<{ file: RunnerFile }>> {
    const answer = await this.ask({ type: "file.read", ...input }, "files");
    if (answer.ok === false) return answer;
    if (answer.type !== "file") return { ok: false, reason: "Unexpected answer from the computer." };
    const { type: _t, requestId: _r, ...file } = answer;
    return { ok: true, file };
  }

  /** Shares or stops sharing a folder on the computer. Callable over RPC. */
  async setShared(path: string, shared: boolean): Promise<RunnerResult<{ folders: RunnerFolder[] }>> {
    const answer = await this.ask({ type: shared ? "folder.share" : "folder.unshare", path });
    if (answer.ok === false) return answer;
    if (answer.type !== "folders") return { ok: false, reason: "Unexpected answer from the computer." };
    await notifyRunnerProjects(this.env, this.name);
    return { ok: true, folders: answer.folders };
  }

  /** Changes the runner's settings on the computer. Callable over RPC. */
  async setSettings(settings: RunnerSettingsInput): Promise<RunnerResult<{ settings: RunnerSettings }>> {
    const answer = await this.ask({ type: "settings.set", settings }, "settings");
    if (answer.ok === false) return answer;
    if (answer.type !== "settings") return { ok: false, reason: "Unexpected answer from the computer." };
    return { ok: true, settings: answer.settings };
  }

  /** Asks the computer to update myrel-runner to `version`. Callable over RPC. */
  async requestUpdate(version: string, now: boolean): Promise<RunnerResult<{ update: RunnerUpdateState }>> {
    const answer = await this.ask({ type: "runner.update", version, now }, "update");
    if (answer.ok === false) return answer;
    if (answer.type !== "update.accepted") return { ok: false, reason: "Unexpected answer from the computer." };
    return { ok: true, update: answer.update };
  }

  /** Makes a key on the computer for a project's SSH server, or takes one of its own (`existing`). Callable over RPC. */
  async sshKeygen(ref: SshKeyRef, comment: string, existing?: string): Promise<RunnerResult<{ publicKey: string; fingerprint: string; protected: boolean }>> {
    const answer = await this.ask({ type: "ssh.keygen", ...ref, comment, ...(existing && { existing }) }, "ssh", 60_000);
    if (answer.ok === false) return answer;
    if (answer.type !== "ssh.key") return { ok: false, reason: "Unexpected answer from the computer." };
    return { ok: true, publicKey: answer.publicKey, fingerprint: answer.fingerprint, protected: answer.protected };
  }

  /** The keys in the computer's ~/.ssh, by name and fingerprint. Callable over RPC. */
  async sshKeys(): Promise<RunnerResult<{ keys: SshLocalKey[] }>> {
    const answer = await this.ask({ type: "ssh.keys" }, "ssh");
    if (answer.ok === false) return answer;
    if (answer.type !== "ssh.keylist") return { ok: false, reason: "Unexpected answer from the computer." };
    return { ok: true, keys: answer.keys };
  }

  /** A server's own keys, fetched from the computer. Callable over RPC. */
  async sshHostKeys(host: string, port: number): Promise<RunnerResult<{ keys: SshHostKey[] }>> {
    const answer = await this.ask({ type: "ssh.hostkeys", host, port }, "ssh", 45_000);
    if (answer.ok === false) return answer;
    if (answer.type !== "ssh.hostkeylist") return { ok: false, reason: "Unexpected answer from the computer." };
    return { ok: true, keys: answer.keys };
  }

  /**
   * A connection test (with `command` absent), or one command the person allowed, run by the
   * computer with its key for that server. Callable over RPC.
   */
  async ssh(target: SshTarget, command?: string): Promise<RunnerResult<{ result: SshResult }>> {
    const answer = command
      ? await this.ask({ type: "ssh.run", target, command }, "ssh", SSH_TIMEOUT_MS + 30_000)
      : await this.ask({ type: "ssh.test", target }, "ssh", 60_000);
    if (answer.ok === false) return answer;
    if (answer.type !== "ssh.result") return { ok: false, reason: "Unexpected answer from the computer." };
    const { type: _t, requestId: _r, ...result } = answer;
    return { ok: true, result };
  }

  /** Deletes the key Myrel made on the computer for a server. Callable over RPC. */
  async sshForget(ref: SshKeyRef): Promise<RunnerResult<object>> {
    const answer = await this.ask({ type: "ssh.forget", ...ref }, "ssh");
    return answer.ok === false ? answer : { ok: true };
  }

  /** Stops every task and closes the connection, e.g. when the runner is removed. Callable over RPC. */
  async revoke(): Promise<void> {
    for (const task of this.sql<TaskRow>`SELECT * FROM tasks WHERE status = 'running'`) {
      await this.finish(task, false, "The computer was disconnected from Myrel.");
    }
    for (const c of this.getConnections()) c.close(4401, "runner removed");
  }

  /** Sends a folder request to the computer and waits for its answer. */
  private async ask(
    question: DistributiveOmit<Question, "requestId">,
    feature: RunnerFeature = "folders",
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<{ ok: false; reason: string } | (Answer & { ok?: undefined })> {
    const [connection] = this.getConnections();
    if (!connection) return { ok: false, reason: "The computer is offline. Start myrel-runner on it first." };
    const [row] = await createDb(this.env.DB)
      .select({ info: schema.runners.info })
      .from(schema.runners)
      .where(eq(schema.runners.id, this.name));
    if (!parseInfo(row?.info ?? null)?.features.includes(feature)) {
      return {
        ok: false,
        reason:
          feature === "files"
            ? "Update myrel-runner on this computer to open its files from here (npx myrel-runner@latest update)."
            : feature === "settings"
              ? "Update myrel-runner on this computer to change its settings from here (npx myrel-runner@latest update)."
              : feature === "update"
                ? "This runner cannot update itself from here. Run `npx myrel-runner@latest update` on the computer once."
                : feature === "ssh"
                  ? "Update myrel-runner on this computer to use SSH from Myrel (npx myrel-runner@latest update)."
                  : "Update myrel-runner on this computer to add folders from here (npx myrel-runner@latest update).",
      };
    }
    const requestId = crypto.randomUUID();
    const answer = await new Promise<Answer | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.waiting.set(requestId, (a) => {
        clearTimeout(timer);
        resolve(a);
      });
      send(connection, { ...question, requestId } as Question);
    }).finally(() => this.waiting.delete(requestId));
    if (!answer) return { ok: false, reason: "The computer did not answer in time." };
    if (answer.type === "request.failed") return { ok: false, reason: answer.message };
    return answer;
  }

  /** Saves part of what the computer told us, between two hellos. */
  private async saveInfo(patch: Partial<Pick<RunnerInfo, "folders" | "settings" | "update">>) {
    const db = createDb(this.env.DB);
    const [row] = await db.select({ info: schema.runners.info }).from(schema.runners).where(eq(schema.runners.id, this.name));
    const info = parseInfo(row?.info ?? null);
    if (!info) return;
    await db
      .update(schema.runners)
      .set({ info: JSON.stringify({ ...info, ...patch }) })
      .where(eq(schema.runners.id, this.name));
  }

  /** The project a coordinator turn works for. */
  private project(task: TaskRow) {
    return getAgentByName(this.env.PROJECT_AGENT, task.project_id);
  }

  /**
   * Hands a task's result to its thread, then records it as finished. If the thread cannot take it
   * (it is restarting for a new version of Myrel), the task stays running, so the result the runner
   * sends again after reconnecting is delivered then.
   */
  private async finish(task: TaskRow, ok: boolean, result: string, cancelled = false) {
    if (task.coordinator) {
      await (await this.project(task)).coordinatorTaskDone(task.id, { ok, result });
      this.sql`UPDATE tasks SET status = ${ok ? "done" : "failed"} WHERE id = ${task.id}`;
      return;
    }
    const detail = ok || cancelled ? undefined : result.trim().split("\n")[0]?.slice(0, 300) || undefined;
    const thread = await getAgentByName(this.env.THREAD_AGENT, task.thread_id);
    await thread.taskEvents(task.id, [
      { type: "text", text: result },
      ok ? { type: "phase", phase: "agent", state: "done" } : { type: "phase", phase: "agent", state: "failed", ...(detail && { detail }) },
      cancelled ? { type: "done", ok: false, error: "Cancelled." } : { type: "done", ok },
    ]);
    this.sql`UPDATE tasks SET status = ${ok ? "done" : "failed"} WHERE id = ${task.id}`;
  }
}

function send(connection: Connection, frame: ServerToRunner) {
  connection.send(JSON.stringify(frame));
}
