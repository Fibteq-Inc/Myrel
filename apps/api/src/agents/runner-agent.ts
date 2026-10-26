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
  RunnerToServer,
  type RunnerUpdateState,
  ServerToRunner,
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
};
export type TaskStartResult = { ok: true } | { ok: false; reason: string };
export type RunnerResult<T> = ({ ok: true } & T) | { ok: false; reason: string };

/** How long the web app waits for the computer to answer a folder request. */
const REQUEST_TIMEOUT_MS = 15_000;

type Answer = Extract<RunnerToServer, { requestId: string }>;
type Question = Extract<ServerToRunner, { requestId: string }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type TaskRow = {
  id: string;
  project_id: string;
  thread_id: string;
  status: "running" | "done" | "failed";
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
    // When the computer connected lately, to tell a runner that keeps going down from one restart.
    this.sql`CREATE TABLE IF NOT EXISTS connects (at INTEGER NOT NULL)`;
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
        return send(connection, { type: "pong" });
      case "hello": {
        if (frame.protocol !== RUNNER_PROTOCOL_VERSION) {
          connection.close(4400, `unsupported runner protocol ${frame.protocol}; update myrel-runner`);
          return;
        }
        const { type: _t, protocol: _p, running, interrupted, ...info } = frame;
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
        const thread = await getAgentByName(this.env.THREAD_AGENT, task.thread_id);
        if (frame.usage) await thread.cliUsage(task.id, frame.usage);
        // Empty text: only the usage changed.
        if (!frame.text) return;
        const project = await getAgentByName(this.env.PROJECT_AGENT, task.project_id);
        // The activity line takes the step's first line; the terminal keeps all of it (an agent's message, a long command).
        await project.setActivity(task.thread_id, true, frame.text.trim().split("\n")[0]!.slice(0, 200));
        await thread.taskEvents(task.id, [{ type: "tool", name: "cli", title: frame.text.trim() }]);
        return;
      }
      case "task.folders": {
        const [task] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${frame.taskId}`;
        if (task?.status !== "running") return;
        await (await getAgentByName(this.env.THREAD_AGENT, task.thread_id)).agentFolders(task.id, frame.folders);
        return;
      }
      case "task.done": {
        const [task] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${frame.taskId}`;
        if (task?.status !== "running") return;
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
      case "request.failed":
        this.waiting.get(frame.requestId)?.(frame);
        return;
    }
  }

  override async onClose(connection: Connection) {
    const others = [...this.getConnections()].filter((c) => c.id !== connection.id);
    if (others.length > 0) return;
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
      cli: input.cli,
      prompt: input.prompt,
      ...(input.agent && { agent: input.agent }),
      ...(input.model && { model: input.model }),
      ...(input.github && { github: input.github }),
    };
    // A runner drops a frame it cannot read, and the task would then wait for output forever.
    const checked = ServerToRunner.safeParse(frame);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      console.error("task.start does not fit the runner protocol", taskId, issue?.path.join("."), issue?.message);
      return { ok: false, reason: `Myrel could not send this task to the computer (${issue?.path.join(".") || "frame"}: ${issue?.message ?? "invalid"}).` };
    }
    this.sql`INSERT INTO tasks (id, project_id, thread_id, status, created_at)
      VALUES (${taskId}, ${input.projectId}, ${input.threadId}, 'running', ${new Date().toISOString()})`;
    send(connection, frame);
    return { ok: true };
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
  async readFile(input: { path: string; folders: string[]; threadId?: string }): Promise<RunnerResult<{ file: RunnerFile }>> {
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
                : "Update myrel-runner on this computer to add folders from here (npx myrel-runner@latest update).",
      };
    }
    const requestId = crypto.randomUUID();
    const answer = await new Promise<Answer | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS);
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

  /**
   * Hands a task's result to its thread, then records it as finished. If the thread cannot take it
   * (it is restarting for a new version of Myrel), the task stays running, so the result the runner
   * sends again after reconnecting is delivered then.
   */
  private async finish(task: TaskRow, ok: boolean, result: string, cancelled = false) {
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
