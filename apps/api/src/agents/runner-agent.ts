import { createDb, schema } from "@myrel/db";
import {
  type AgentConnector,
  type CliId,
  RUNNER_PROTOCOL_VERSION,
  type RunnerDirListing,
  type RunnerFolder,
  RunnerToServer,
  type ServerToRunner,
} from "@myrel/protocol";
import { Agent, type Connection, type ConnectionContext, getAgentByName } from "agents";
import { eq } from "drizzle-orm";
import { notifyRunnerProjects, parseInfo, RUNNER_ID_HEADER } from "../runners";

export type TaskStart = {
  taskId: string;
  projectId: string;
  threadId: string;
  folder: string;
  cli: CliId;
  prompt: string;
  /** The CLI runs as the thread's agent, connected to the thread's MCP endpoint (needs feature "agent"). */
  agent?: { mcpPath: string; token: string; connectors?: AgentConnector[] };
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
  }

  override shouldSendProtocolMessages(): boolean {
    return false;
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
        const { type: _t, protocol: _p, running, ...info } = frame;
        await createDb(this.env.DB)
          .update(schema.runners)
          .set({ info: JSON.stringify(info), lastSeenAt: new Date() })
          .where(eq(schema.runners.id, this.name));
        // Tasks we think are running but the computer no longer knows about died with it.
        const alive = new Set(running);
        for (const task of this.sql<TaskRow>`SELECT * FROM tasks WHERE status = 'running'`) {
          if (!alive.has(task.id)) await this.finish(task, false, "The task stopped when the computer disconnected.");
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
        await project.setActivity(task.thread_id, true, frame.text.slice(0, 200));
        await thread.taskEvents(task.id, [{ type: "tool", name: "cli", title: frame.text.slice(0, 200) }]);
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
        await this.saveFolders(frame.folders);
        this.waiting.get(frame.requestId)?.(frame);
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
    this.sql`INSERT INTO tasks (id, project_id, thread_id, status, created_at)
      VALUES (${taskId}, ${input.projectId}, ${input.threadId}, 'running', ${new Date().toISOString()})`;
    send(connection, {
      type: "task.start",
      taskId,
      threadId: input.threadId,
      folder: input.folder,
      cli: input.cli,
      prompt: input.prompt,
      ...(input.agent && { agent: input.agent }),
    });
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

  /** Shares or stops sharing a folder on the computer. Callable over RPC. */
  async setShared(path: string, shared: boolean): Promise<RunnerResult<{ folders: RunnerFolder[] }>> {
    const answer = await this.ask({ type: shared ? "folder.share" : "folder.unshare", path });
    if (answer.ok === false) return answer;
    if (answer.type !== "folders") return { ok: false, reason: "Unexpected answer from the computer." };
    await notifyRunnerProjects(this.env, this.name);
    return { ok: true, folders: answer.folders };
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
  ): Promise<{ ok: false; reason: string } | (Answer & { ok?: undefined })> {
    const [connection] = this.getConnections();
    if (!connection) return { ok: false, reason: "The computer is offline. Start myrel-runner on it first." };
    const [row] = await createDb(this.env.DB)
      .select({ info: schema.runners.info })
      .from(schema.runners)
      .where(eq(schema.runners.id, this.name));
    if (!parseInfo(row?.info ?? null)?.features.includes("folders")) {
      return { ok: false, reason: "Update myrel-runner on this computer to add folders from here (npx myrel-runner@latest update)." };
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

  private async saveFolders(folders: RunnerFolder[]) {
    const db = createDb(this.env.DB);
    const [row] = await db.select({ info: schema.runners.info }).from(schema.runners).where(eq(schema.runners.id, this.name));
    const info = parseInfo(row?.info ?? null);
    if (!info) return;
    await db
      .update(schema.runners)
      .set({ info: JSON.stringify({ ...info, folders }) })
      .where(eq(schema.runners.id, this.name));
  }

  private async finish(task: TaskRow, ok: boolean, result: string, cancelled = false) {
    this.sql`UPDATE tasks SET status = ${ok ? "done" : "failed"} WHERE id = ${task.id}`;
    const thread = await getAgentByName(this.env.THREAD_AGENT, task.thread_id);
    await thread.taskEvents(task.id, [
      { type: "text", text: result },
      ok ? { type: "phase", phase: "agent", state: "done" } : { type: "phase", phase: "agent", state: "failed" },
      cancelled ? { type: "done", ok: false, error: "Cancelled." } : { type: "done", ok },
    ]);
  }
}

function send(connection: Connection, frame: ServerToRunner) {
  connection.send(JSON.stringify(frame));
}
