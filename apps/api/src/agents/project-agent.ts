import { createDb, schema } from "@altair/db";
import {
  type AuthorKind,
  ClientEvent,
  createId,
  type Message,
  type Reaction,
  type ServerEvent,
  SYNC_PAGE_SIZE,
  type Thread,
  type ThreadStatus,
} from "@altair/protocol";
import { Agent, type Connection, type ConnectionContext, getAgentByName } from "agents";
import { eq } from "drizzle-orm";
import { createProvider, runLoop } from "../llm";
import { type CoordinatorHost, coordinatorPrompt, coordinatorTools, COORDINATOR_SYSTEM, type InboxItem } from "./coordinator";
import { COORDINATOR_ID, SYSTEM_ID } from "./names";

/** Header the API Worker sets after authenticating a WebSocket upgrade. */
export const USER_ID_HEADER = "x-altair-user-id";

type ConnState = { userId: string };

type MessageRow = {
  seq: number;
  id: string;
  thread_id: string | null;
  author_kind: AuthorKind;
  author_id: string;
  body: string;
  created_at: string;
};

type ThreadRow = {
  id: string;
  root_message_id: string;
  title: string;
  status: ThreadStatus;
  status_text: string | null;
  resolved: number;
  label: string | null;
  created_at: string;
  updated_at: string;
};

type InboxRow = { id: number; kind: InboxItem["kind"]; payload: string };

export type NewMessage = Pick<Message, "threadId" | "authorKind" | "authorId" | "body">;

export type ThreadPatch = Partial<Pick<Thread, "title" | "status" | "statusText" | "resolved" | "label">>;

/** What a thread agent reads at the start of each turn. */
export type ThreadContext = {
  projectName: string;
  thread: Thread;
  root: Message;
  messages: Message[];
  names: Record<string, string>;
};

export type CoordinatorRequestKind = "permission" | "routing" | "handoff";

/** Most recent project-chat messages the coordinator sees each turn. */
const COORDINATOR_HISTORY = 40;

/**
 * One instance per project (named by project id). Owns the project chat and
 * thread index: messages live in this DO's SQLite with a monotonically
 * increasing `seq` so clients can resume with "give me everything after seq N".
 * It also runs the coordinator, whose turns are queued durably.
 */
export class ProjectAgent extends Agent<Env> {
  static override options = { sendIdentityOnConnect: false };

  /** Agents currently working: null = coordinator, otherwise a thread id. In memory only. */
  private active = new Set<string | null>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      thread_id TEXT,
      author_kind TEXT NOT NULL,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      root_message_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      status_text TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      author_kind TEXT NOT NULL,
      author_id TEXT NOT NULL,
      PRIMARY KEY (message_id, emoji, author_id)
    )`;
    // Things the coordinator has not looked at yet: new project-chat messages, thread requests.
    this.sql`CREATE TABLE IF NOT EXISTS coordinator_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL
    )`;
  }

  // Our clients speak the Altair protocol only; skip the SDK's state/identity frames.
  override shouldSendProtocolMessages(): boolean {
    return false;
  }

  override onConnect(connection: Connection, { request }: ConnectionContext) {
    const userId = request.headers.get(USER_ID_HEADER);
    if (!userId) {
      connection.close(4401, "unauthorized");
      return;
    }
    connection.setState({ userId });
  }

  override async onMessage(connection: Connection, raw: string | ArrayBuffer | ArrayBufferView) {
    const userId = (connection.state as ConnState | null)?.userId;
    if (!userId) return connection.close(4401, "unauthorized");

    let data: unknown;
    try {
      data = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return send(connection, { type: "error", code: "bad_json", message: "Invalid JSON" });
    }
    const parsed = ClientEvent.safeParse(data);
    if (!parsed.success) {
      return send(connection, { type: "error", code: "bad_event", message: parsed.error.message });
    }

    const event = parsed.data;
    switch (event.type) {
      case "message.send": {
        if (event.threadId && !this.getThread(event.threadId)) {
          return send(connection, { type: "error", code: "no_thread", message: "Thread not found" });
        }
        const message = this.sendMessage({
          threadId: event.threadId,
          authorKind: "user",
          authorId: userId,
          body: event.body,
        });
        if (event.clientId) {
          send(connection, { type: "message.ack", clientId: event.clientId, messageId: message.id, seq: message.seq });
        }
        if (message.threadId) await this.wakeThread(message.threadId, { kind: "message", messageId: message.id });
        else await this.notifyCoordinator({ kind: "message", messageId: message.id });
        return;
      }
      case "thread.resolve": {
        if (!this.getThread(event.threadId)) {
          return send(connection, { type: "error", code: "no_thread", message: "Thread not found" });
        }
        this.updateThread(event.threadId, {
          resolved: event.resolved,
          status: event.resolved ? "done" : "review_ready",
        });
        return;
      }
      case "sync": {
        const page = this.getMessagesAfter(event.afterSeq);
        send(connection, {
          type: "sync.result",
          ...page,
          threads: this.listThreads(),
          reactions: this.reactionsFor(page.messages.map((m) => m.id)),
        });
        for (const threadId of this.active) send(connection, { type: "agent.activity", threadId, active: true });
        return;
      }
    }
  }

  // ---- Messages ----------------------------------------------------------

  /** Store a message and broadcast it to every connected client. Callable over RPC. */
  sendMessage(input: NewMessage): Message {
    const id = createId("message");
    const createdAt = new Date().toISOString();
    const [row] = this.sql<{ seq: number }>`
      INSERT INTO messages (id, thread_id, author_kind, author_id, body, created_at)
      VALUES (${id}, ${input.threadId}, ${input.authorKind}, ${input.authorId}, ${input.body}, ${createdAt})
      RETURNING seq`;
    const message: Message = { ...input, id, projectId: this.name, seq: row!.seq, createdAt };
    this.emit({ type: "message.created", message });
    return message;
  }

  /** Messages with seq > afterSeq, oldest first. Callable over RPC. */
  getMessagesAfter(afterSeq: number, limit = SYNC_PAGE_SIZE): { messages: Message[]; hasMore: boolean } {
    const rows = this.sql<MessageRow>`
      SELECT * FROM messages WHERE seq > ${afterSeq} ORDER BY seq LIMIT ${limit + 1}`;
    return { messages: rows.slice(0, limit).map((r) => this.toMessage(r)), hasMore: rows.length > limit };
  }

  getMessage(id: string): Message | null {
    const [row] = this.sql<MessageRow>`SELECT * FROM messages WHERE id = ${id}`;
    return row ? this.toMessage(row) : null;
  }

  addReaction(reaction: Reaction): void {
    this.sql`INSERT OR IGNORE INTO reactions (message_id, emoji, author_kind, author_id)
      VALUES (${reaction.messageId}, ${reaction.emoji}, ${reaction.authorKind}, ${reaction.authorId})`;
    this.emit({ type: "reaction.added", reaction });
  }

  private reactionsFor(messageIds: string[]): Reaction[] {
    if (messageIds.length === 0) return [];
    const ids = new Set(messageIds);
    // Reactions are rare; filtering in memory avoids building a dynamic IN list.
    return this.sql<{ message_id: string; emoji: string; author_kind: AuthorKind; author_id: string }>`
      SELECT * FROM reactions`
      .filter((r) => ids.has(r.message_id))
      .map((r) => ({ messageId: r.message_id, emoji: r.emoji, authorKind: r.author_kind, authorId: r.author_id }));
  }

  // ---- Threads -----------------------------------------------------------

  /** Opens a thread under a project-chat message. Callable over RPC. */
  createThread(rootMessageId: string, title: string): Thread {
    const id = createId("thread");
    const now = new Date().toISOString();
    this.sql`INSERT INTO threads (id, root_message_id, title, status, status_text, resolved, label, created_at, updated_at)
      VALUES (${id}, ${rootMessageId}, ${title}, ${"working"}, ${null}, 0, ${null}, ${now}, ${now})`;
    const thread = this.getThread(id)!;
    this.emit({ type: "thread.updated", thread });
    return thread;
  }

  getThread(id: string): Thread | null {
    const [row] = this.sql<ThreadRow>`SELECT * FROM threads WHERE id = ${id}`;
    return row ? this.toThread(row) : null;
  }

  listThreads(): Thread[] {
    return this.sql<ThreadRow>`SELECT * FROM threads ORDER BY created_at`.map((r) => this.toThread(r));
  }

  updateThread(id: string, patch: ThreadPatch): Thread | null {
    const current = this.getThread(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.sql`UPDATE threads SET title = ${next.title}, status = ${next.status}, status_text = ${next.statusText},
      resolved = ${next.resolved ? 1 : 0}, label = ${next.label}, updated_at = ${next.updatedAt} WHERE id = ${id}`;
    this.emit({ type: "thread.updated", thread: next });
    return next;
  }

  /** Everything a thread agent needs for one turn. Callable over RPC. */
  async getThreadContext(threadId: string): Promise<ThreadContext | null> {
    const thread = this.getThread(threadId);
    const root = thread && this.getMessage(thread.rootMessageId);
    if (!thread || !root) return null;
    const messages = this.sql<MessageRow>`SELECT * FROM messages WHERE thread_id = ${threadId} ORDER BY seq`.map((r) =>
      this.toMessage(r),
    );
    const { projectName, names } = await this.directory();
    return { projectName, thread, root, messages, names };
  }

  /** A thread agent asks the coordinator for permission or direction. Callable over RPC. */
  async requestCoordinator(threadId: string, kind: CoordinatorRequestKind, reason: string): Promise<void> {
    await this.notifyCoordinator({ kind: "request", threadId, request: kind, reason });
  }

  /** Thread agents report when they start and stop working. Callable over RPC. */
  setActivity(threadId: string | null, active: boolean): void {
    if (active === this.active.has(threadId)) return;
    if (active) this.active.add(threadId);
    else this.active.delete(threadId);
    this.emit({ type: "agent.activity", threadId, active });
  }

  /** A thread's task changed or printed output; relay it to clients. Callable over RPC. */
  broadcastTask(event: Extract<ServerEvent, { type: "task.updated" | "task.output" }>): void {
    this.emit(event);
  }

  private async wakeThread(threadId: string, reason: ThreadWake) {
    const agent = await getAgentByName(this.env.THREAD_AGENT, threadId);
    await agent.wake(reason);
  }

  // ---- Coordinator -------------------------------------------------------

  private async notifyCoordinator(item: InboxItem) {
    this.sql`INSERT INTO coordinator_inbox (kind, payload) VALUES (${item.kind}, ${JSON.stringify(item)})`;
    await this.queue("coordinatorTurn", null);
  }

  /** Queue callback: one coordinator turn over everything in the inbox. */
  async coordinatorTurn(): Promise<void> {
    const rows = this.sql<InboxRow>`SELECT * FROM coordinator_inbox ORDER BY id`;
    if (rows.length === 0) return; // an earlier turn already took these
    this.sql`DELETE FROM coordinator_inbox WHERE id <= ${rows.at(-1)!.id}`;
    const inbox = rows.map((r) => JSON.parse(r.payload) as InboxItem);

    const llm = createProvider(this.env);
    if (!llm.ok) {
      this.sendMessage({ threadId: null, authorKind: "system", authorId: SYSTEM_ID, body: llm.reason });
      return;
    }

    this.setActivity(null, true);
    try {
      const { projectName, names } = await this.directory();
      const chat = this.sql<MessageRow>`
        SELECT * FROM (SELECT * FROM messages WHERE thread_id IS NULL ORDER BY seq DESC LIMIT ${COORDINATOR_HISTORY})
        ORDER BY seq`.map((r) => this.toMessage(r));
      await runLoop({
        provider: llm.provider,
        system: COORDINATOR_SYSTEM,
        prompt: coordinatorPrompt({ projectName, names, chat, threads: this.listThreads(), inbox }),
        tools: coordinatorTools(this.coordinatorHost()),
        maxSteps: 8,
      });
    } catch (err) {
      console.error("coordinator turn failed", err);
      this.sendMessage({
        threadId: null,
        authorKind: "system",
        authorId: SYSTEM_ID,
        body: `The coordinator could not answer: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      this.setActivity(null, false);
    }
  }

  private coordinatorHost(): CoordinatorHost {
    return {
      getMessage: (id) => this.getMessage(id),
      getThread: (id) => this.getThread(id),
      threadForRoot: (messageId) => this.listThreads().find((t) => t.rootMessageId === messageId) ?? null,
      post: (body) => this.sendMessage({ threadId: null, authorKind: "agent", authorId: COORDINATOR_ID, body }),
      react: (messageId, emoji) => this.addReaction({ messageId, emoji, authorKind: "agent", authorId: COORDINATOR_ID }),
      startThread: async ({ rootMessageId, title, brief, ack }) => {
        const thread = this.createThread(rootMessageId, title);
        if (ack) this.sendMessage({ threadId: thread.id, authorKind: "agent", authorId: COORDINATOR_ID, body: ack });
        const agent = await getAgentByName(this.env.THREAD_AGENT, thread.id);
        await agent.start({ projectId: this.name, threadId: thread.id, brief });
        return thread;
      },
      messageThread: async (threadId, note) => {
        const thread = this.getThread(threadId);
        if (thread?.resolved) this.updateThread(threadId, { resolved: false });
        await this.wakeThread(threadId, { kind: "coordinator", note });
      },
    };
  }

  /** Project name and member display names, for prompts. */
  private async directory(): Promise<{ projectName: string; names: Record<string, string> }> {
    const db = createDb(this.env.DB);
    const [project] = await db
      .select({ name: schema.projects.name })
      .from(schema.projects)
      .where(eq(schema.projects.id, this.name));
    const members = await db
      .select({ id: schema.user.id, name: schema.user.name })
      .from(schema.projectMembers)
      .innerJoin(schema.user, eq(schema.user.id, schema.projectMembers.userId))
      .where(eq(schema.projectMembers.projectId, this.name));
    return { projectName: project?.name ?? "Project", names: Object.fromEntries(members.map((m) => [m.id, m.name])) };
  }

  // ---- Helpers -----------------------------------------------------------

  private emit(event: ServerEvent) {
    this.broadcast(JSON.stringify(event));
  }

  private toMessage(r: MessageRow): Message {
    return {
      id: r.id,
      projectId: this.name,
      threadId: r.thread_id,
      authorKind: r.author_kind,
      authorId: r.author_id,
      body: r.body,
      seq: r.seq,
      createdAt: r.created_at,
    };
  }

  private toThread(r: ThreadRow): Thread {
    return {
      id: r.id,
      projectId: this.name,
      rootMessageId: r.root_message_id,
      title: r.title,
      status: r.status,
      statusText: r.status_text,
      resolved: r.resolved === 1,
      label: r.label,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

/** Why a thread agent is woken. */
export type ThreadWake = { kind: "message"; messageId: string } | { kind: "coordinator"; note: string };

function send(connection: Connection, event: ServerEvent) {
  connection.send(JSON.stringify(event));
}
