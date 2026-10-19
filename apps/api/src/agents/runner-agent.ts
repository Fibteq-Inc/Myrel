import { createDb, schema } from "@altair/db";
import {
  type CliId,
  RUNNER_PROTOCOL_VERSION,
  RunnerToServer,
  type ServerToRunner,
} from "@altair/protocol";
import { Agent, type Connection, type ConnectionContext, getAgentByName } from "agents";
import { eq } from "drizzle-orm";
import { notifyRunnerProjects, RUNNER_ID_HEADER } from "../runners";

export type TaskStart = { taskId: string; projectId: string; threadId: string; folder: string; cli: CliId; prompt: string };
export type TaskStartResult = { ok: true } | { ok: false; reason: string };

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
    // One live connection per runner: a second `altair-runner start` replaces the first.
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
          connection.close(4400, `unsupported runner protocol ${frame.protocol}; update altair-runner`);
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
        const project = await getAgentByName(this.env.PROJECT_AGENT, task.project_id);
        await project.setActivity(task.thread_id, true, frame.text.slice(0, 200));
        return;
      }
      case "task.done": {
        const [task] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${frame.taskId}`;
        if (task?.status === "running") await this.finish(task, frame.ok, frame.result);
        return;
      }
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
    if (!connection) return { ok: false, reason: "The computer is offline. Ask the person to run `altair-runner start` on it." };
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
    });
    return { ok: true };
  }

  /** Stops every task and closes the connection, e.g. when the runner is removed. Callable over RPC. */
  async revoke(): Promise<void> {
    for (const task of this.sql<TaskRow>`SELECT * FROM tasks WHERE status = 'running'`) {
      await this.finish(task, false, "The computer was disconnected from Altair.");
    }
    for (const c of this.getConnections()) c.close(4401, "runner removed");
  }

  private async finish(task: TaskRow, ok: boolean, result: string) {
    this.sql`UPDATE tasks SET status = ${ok ? "done" : "failed"} WHERE id = ${task.id}`;
    const thread = await getAgentByName(this.env.THREAD_AGENT, task.thread_id);
    await thread.wake({ kind: "task", taskId: task.id, ok, result });
  }
}

function send(connection: Connection, frame: ServerToRunner) {
  connection.send(JSON.stringify(frame));
}
