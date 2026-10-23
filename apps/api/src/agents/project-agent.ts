import { createDb, schema } from "@myrel/db";
import {
  type Attachment,
  type Artifact,
  type ArtifactVersion,
  type AuthorKind,
  type CliId,
  ClientEvent,
  type CreateRoutineInput,
  createId,
  type Message,
  type MessageRelay,
  type MessageStats,
  type ArtifactRef,
  nextCronRun,
  normalizeFilePath,
  isPlanMessage,
  type NotificationKind,
  type PullRequest,
  type Reaction,
  type Routine,
  type RoutineSchedule,
  type RoutineTarget,
  type ServerEvent,
  SYNC_PAGE_SIZE,
  type Thread,
  type ThreadCli,
  type ThreadCloseReason,
  type ThreadStatus,
  type UpdateRoutineInput,
} from "@myrel/protocol";
import { Agent, type Connection, type ConnectionContext, getAgentByName } from "agents";
import { eq } from "drizzle-orm";
import { canUseCoordinator } from "../extensions";
import { projectProvider } from "../keys";
import { runLoop } from "../llm";
import { ArtifactError, ArtifactStore, type PublishInput } from "./artifact-store";
import { listPullRequests } from "../github/pulls";
import { deliverNotification, excerpt } from "../notifications/deliver";
import {
  type CoordinatorHost,
  coordinatorPrompt,
  coordinatorTools,
  COORDINATOR_SYSTEM,
  type InboxItem,
  type Relay,
} from "./coordinator";
import { type Author, type KnowledgeHost, type KnowledgeSnapshot, KnowledgeStore } from "./knowledge";
import { meteredForTurn, TurnMeter } from "../usage";
import { COORDINATOR_ID, ROUTINE_ID, SYSTEM_ID, THREAD_AGENT_ID } from "./names";
import { relayLine } from "./relay-line";
import { workspaceClis } from "../runners";
import { type RoutineHost, routineTools } from "./routine-tools";

/** Header the API Worker sets after authenticating a WebSocket upgrade. */
export const USER_ID_HEADER = "x-myrel-user-id";
/** Header with the upgrade's session, `<id>:<expires ms>`, so the connection ends with it. */
export const SESSION_HEADER = "x-myrel-session";

type ConnState = { userId: string; sessionId: string; expiresAt: number };

type MessageRow = {
  seq: number;
  id: string;
  thread_id: string | null;
  author_kind: AuthorKind;
  author_id: string;
  body: string;
  attachments: string | null;
  /** JSON array of ArtifactRef, or null. */
  artifacts: string | null;
  /** JSON MessageStats, or null. */
  stats: string | null;
  /** JSON MessageRelay, or null. */
  relay: string | null;
  /** JSON array of CliId, or null. */
  clis: string | null;
  created_at: string;
};

type ThreadRow = {
  id: string;
  root_message_id: string;
  ack_message_id: string | null;
  title: string;
  status: ThreadStatus;
  status_text: string | null;
  resolved: number;
  close_reason: ThreadCloseReason | null;
  duplicate_of: string | null;
  label: string | null;
  /** JSON ThreadCli, or null. */
  cli: string | null;
  created_at: string;
  updated_at: string;
};

type InboxRow = { id: number; kind: InboxItem["kind"]; payload: string };

type RoutineRow = {
  id: string;
  name: string;
  prompt: string;
  target: string;
  schedule: string;
  paused: number;
  next_run_at: string | null;
  last_run_at: string | null;
  run_count: number;
  schedule_id: string | null;
  created_by: string;
  created_at: string;
};

export type NewMessage = Pick<Message, "threadId" | "authorKind" | "authorId" | "body"> & {
  attachments?: Attachment[];
  artifacts?: ArtifactRef[];
  stats?: MessageStats;
  relay?: MessageRelay;
  clis?: string[];
};

export type ThreadPatch = Partial<
  Pick<Thread, "title" | "status" | "statusText" | "resolved" | "closeReason" | "duplicateOf" | "label" | "cli">
>;

/** What a thread agent reads at the start of each turn. */
export type ThreadContext = {
  projectName: string;
  thread: Thread;
  root: Message;
  messages: Message[];
  names: Record<string, string>;
  knowledge: KnowledgeSnapshot;
  routines: Routine[];
  defaultTimezone: string;
};

export type CoordinatorRequestKind = "permission" | "routing" | "handoff";

/**
 * How long the coordinator waits after a message inside a thread before looking at thread updates,
 * so a burst of replies costs one turn. A project-chat message runs it right away and takes them too.
 */
const OBSERVE_DELAY_SEC = 60;
/** Relays the coordinator sees each turn, so it does not repeat one. */
const RELAY_HISTORY = 20;
/** A relay between the same two threads (either way) within this window is refused, so notes cannot bounce. */
const RELAY_COOLDOWN_MS = 10 * 60 * 1000;
/** A person's ask that repeats one of theirs from this recently is taken for a duplicate, not a new thread. */
const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;

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

  /** Agents currently working (null = coordinator, otherwise a thread id) and what they are doing. In memory only. */
  private active = new Map<string | null, string | undefined>();

  /** Activity counts last written to D1 for the project list, and the write in flight. */
  private syncedActivity: string | null = null;
  private activityWrite: Promise<void> = Promise.resolve();

  /** Project instructions, memory and the file index. */
  readonly knowledge: KnowledgeStore;

  private readonly artifacts: ArtifactStore;

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
    // Added with project files; older projects get the column here.
    const columns = this.sql<{ name: string }>`PRAGMA table_info(messages)`;
    if (!columns.some((c) => c.name === "attachments")) this.sql`ALTER TABLE messages ADD COLUMN attachments TEXT`;
    // Added with artifacts.
    if (!columns.some((c) => c.name === "artifacts")) this.sql`ALTER TABLE messages ADD COLUMN artifacts TEXT`;
    // Added with per-message stats.
    if (!columns.some((c) => c.name === "stats")) this.sql`ALTER TABLE messages ADD COLUMN stats TEXT`;
    // Added with relay lines: the coordinator's note to a thread, which people can open.
    if (!columns.some((c) => c.name === "relay")) this.sql`ALTER TABLE messages ADD COLUMN relay TEXT`;
    // Added with picking CLIs per ask.
    if (!columns.some((c) => c.name === "clis")) this.sql`ALTER TABLE messages ADD COLUMN clis TEXT`;
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
    // Added with the coordinator's acknowledgement line.
    const threadColumns = this.sql<{ name: string }>`PRAGMA table_info(threads)`;
    if (!threadColumns.some((c) => c.name === "ack_message_id")) this.sql`ALTER TABLE threads ADD COLUMN ack_message_id TEXT`;
    // Added with closing threads opened by mistake.
    if (!threadColumns.some((c) => c.name === "close_reason")) {
      this.sql`ALTER TABLE threads ADD COLUMN close_reason TEXT`;
      this.sql`ALTER TABLE threads ADD COLUMN duplicate_of TEXT`;
    }
    // Added with picking a thread's CLI.
    if (!threadColumns.some((c) => c.name === "cli")) this.sql`ALTER TABLE threads ADD COLUMN cli TEXT`;
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
    // Notes the coordinator passed from one thread to another.
    this.sql`CREATE TABLE IF NOT EXISTS coordinator_relays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_thread_id TEXT NOT NULL,
      to_thread_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
    this.knowledge = new KnowledgeStore(
      (strings, ...values) => this.sql(strings, ...values),
      env.FILES,
      () => this.name,
      (kind) => this.emit({ type: "knowledge.changed", kind }),
    );
    this.artifacts = new ArtifactStore(this.sql.bind(this), env.ARTIFACTS, this.name);
    // Scheduled wake-ups. Each armed routine has one pending Agents SDK schedule (a DO alarm).
    this.sql`CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      target TEXT NOT NULL,
      schedule TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      next_run_at TEXT,
      last_run_at TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      schedule_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
  }

  // Our clients speak the Myrel protocol only; skip the SDK's state/identity frames.
  override shouldSendProtocolMessages(): boolean {
    return false;
  }

  /** Clients never write the agent's synced state: everything they send goes through onMessage's checks. */
  override shouldConnectionBeReadonly(): boolean {
    return true;
  }

  override onConnect(connection: Connection, { request }: ConnectionContext) {
    const userId = request.headers.get(USER_ID_HEADER);
    const [sessionId, expires] = (request.headers.get(SESSION_HEADER) ?? "").split(":");
    if (!userId || !sessionId || !Number(expires)) {
      connection.close(4401, "unauthorized");
      return;
    }
    connection.setState({ userId, sessionId, expiresAt: Number(expires) } satisfies ConnState);
    // Remembered for links in notification emails when BETTER_AUTH_URL is not set.
    this.ctx.storage.kv.put("origin", new URL(request.url).origin);
  }

  override async onMessage(connection: Connection, raw: string | ArrayBuffer | ArrayBufferView) {
    const state = connection.state as ConnState | null;
    // Checked on every message: being let in once does not outlive the membership or the session.
    if (!state || !(await this.stillAllowed(state))) return connection.close(4401, "unauthorized");
    const { userId } = state;

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
        let attachments: Attachment[];
        try {
          attachments = this.knowledge.attachmentsFor(event.attachments);
        } catch (err) {
          return send(connection, { type: "error", code: "no_file", message: (err as Error).message });
        }
        // Only a new ask carries CLIs, and only ones installed on the sender's own computer.
        const clis = !event.threadId && event.clis?.length ? await this.offeredClis(userId, event.clis) : [];
        const message = this.sendMessage({
          threadId: event.threadId,
          authorKind: "user",
          authorId: userId,
          body: event.body,
          attachments,
          ...(clis.length && { clis }),
        });
        if (event.clientId) {
          send(connection, { type: "message.ack", clientId: event.clientId, messageId: message.id, seq: message.seq });
        }
        if (message.threadId) await this.threadMessageArrived(message, userId);
        else await this.notifyCoordinator({ kind: "message", messageId: message.id });
        return;
      }
      case "thread.resolve": {
        if (!this.getThread(event.threadId)) {
          return send(connection, { type: "error", code: "no_thread", message: "Thread not found" });
        }
        if (event.resolved && event.reason) {
          await this.closeThread(event.threadId, { reason: event.reason, by: "person" });
          return;
        }
        this.updateThread(event.threadId, {
          resolved: event.resolved,
          status: event.resolved ? "done" : "review_ready",
        });
        return;
      }
      case "thread.cli": {
        const thread = this.getThread(event.threadId);
        if (!thread) return send(connection, { type: "error", code: "no_thread", message: "Thread not found" });
        if (event.cli === null) {
          this.updateThread(thread.id, { cli: null });
          return;
        }
        const [cli] = await this.offeredClis(userId, [event.cli]);
        if (!cli) {
          return send(connection, {
            type: "error",
            code: "no_cli",
            message: "Only the person whose computer runs this project can pick its CLI, and only one installed there.",
          });
        }
        this.updateThread(thread.id, { cli: { id: cli, options: [cli], by: "person", reason: null } });
        return;
      }
      case "sync": {
        const threads = this.listThreads();
        const artifacts = this.artifacts.list();
        const routines = this.listRoutines();
        let afterSeq = event.afterSeq;
        for (;;) {
          const page = this.getMessagesAfter(afterSeq);
          send(connection, {
            type: "sync.result",
            ...page,
            ...(event.all ? { streamed: true } : {}),
            threads,
            reactions: this.reactionsFor(page.messages.map((m) => m.id)),
            artifacts,
            routines,
          });
          if (!event.all || !page.hasMore) break;
          afterSeq = page.messages.at(-1)!.seq;
        }
        for (const [threadId, label] of this.active) {
          send(connection, { type: "agent.activity", threadId, active: true, label });
        }
        return;
      }
    }
  }

  // ---- Messages ----------------------------------------------------------

  /** Store a message and broadcast it to every connected client. Callable over RPC. */
  sendMessage(input: NewMessage): Message {
    const id = createId("message");
    const createdAt = new Date().toISOString();
    const attachments = input.attachments ?? [];
    const stored = attachments.length ? JSON.stringify(attachments) : null;
    const artifacts = input.artifacts?.length ? input.artifacts : undefined;
    const [row] = this.sql<{ seq: number }>`
      INSERT INTO messages (id, thread_id, author_kind, author_id, body, attachments, artifacts, stats, relay, clis, created_at)
      VALUES (${id}, ${input.threadId}, ${input.authorKind}, ${input.authorId}, ${input.body}, ${stored},
        ${artifacts ? JSON.stringify(artifacts) : null}, ${input.stats ? JSON.stringify(input.stats) : null},
        ${input.relay ? JSON.stringify(input.relay) : null}, ${input.clis?.length ? JSON.stringify(input.clis) : null}, ${createdAt})
      RETURNING seq`;
    const { artifacts: _, ...rest } = input;
    const message: Message = {
      ...rest,
      attachments,
      ...(artifacts && { artifacts }),
      id,
      projectId: this.name,
      seq: row!.seq,
      createdAt,
    };
    this.emit({ type: "message.created", message });
    if (this.observable(message)) this.ctx.waitUntil(this.observeThread(message));
    return message;
  }

  /**
   * A line Myrel writes in a thread for a person, after something they did there other than
   * writing (connecting a connector from a card, say). It wakes the thread like their own message.
   * Callable over RPC.
   */
  async sendAsUser(threadId: string, userId: string, body: string): Promise<Message | null> {
    if (!this.getThread(threadId)) return null;
    const message = this.sendMessage({ threadId, authorKind: "user", authorId: userId, body });
    await this.threadMessageArrived(message, userId);
    return message;
  }

  /** A person's message in a thread: a finished thread picks up again, and its agent wakes. */
  private async threadMessageArrived(message: Message, userId: string) {
    const threadId = message.threadId!;
    const reopened = !!this.getThread(threadId)?.resolved;
    if (reopened) this.updateThread(threadId, { resolved: false, status: "working" });
    await this.wakeThread(threadId, { kind: "message", messageId: message.id, body: message.body, authorId: userId, seq: message.seq, reopened });
  }

  /** Messages with seq > afterSeq, oldest first. Callable over RPC. */
  getMessagesAfter(afterSeq: number, limit = SYNC_PAGE_SIZE): { messages: Message[]; hasMore: boolean } {
    const rows = this.sql<MessageRow>`
      SELECT * FROM messages WHERE seq > ${afterSeq} ORDER BY seq LIMIT ${limit + 1}`;
    return { messages: rows.slice(0, limit).map((r) => this.toMessage(r)), hasMore: rows.length > limit };
  }

  /** The id of a thread's newest message, or null when it has none. Callable over RPC. */
  lastThreadMessageId(threadId: string): string | null {
    const [row] = this.sql<{ id: string }>`SELECT id FROM messages WHERE thread_id = ${threadId} ORDER BY seq DESC LIMIT 1`;
    return row?.id ?? null;
  }

  getMessage(id: string): Message | null {
    const [row] = this.sql<MessageRow>`SELECT * FROM messages WHERE id = ${id}`;
    return row ? this.toMessage(row) : null;
  }

  /** Replaces a message's body and tells every client. Callable over RPC. */
  editMessage(id: string, body: string): Message | null {
    this.sql`UPDATE messages SET body = ${body} WHERE id = ${id}`;
    const message = this.getMessage(id);
    if (message) this.emit({ type: "message.updated", message });
    return message;
  }

  /** Replaces what an agent message's stats line says, e.g. with usage reported after it was sent. Callable over RPC. */
  setMessageStats(id: string, stats: MessageStats): Message | null {
    this.sql`UPDATE messages SET stats = ${JSON.stringify(stats)} WHERE id = ${id}`;
    const message = this.getMessage(id);
    if (message) this.emit({ type: "message.updated", message });
    return message;
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

  /**
   * Of the CLIs a person offered, in their order and once each, those installed on the project
   * folder's computer, and none unless that computer is theirs: a turn only runs there for its owner.
   */
  private async offeredClis(userId: string, wanted: CliId[]): Promise<CliId[]> {
    const computer = await workspaceClis(this.env, this.name);
    if (!computer || computer.ownerId !== userId) return [];
    const installed = new Set(computer.clis.map((c) => c.id));
    return [...new Set(wanted)].filter((c) => installed.has(c));
  }

  // ---- Threads -----------------------------------------------------------

  /** Opens a thread under a project-chat message. Callable over RPC. */
  createThread(
    rootMessageId: string,
    title: string,
    ackMessageId: string | null = null,
    id = createId("thread"),
    cli: ThreadCli | null = null,
  ): Thread {
    const now = new Date().toISOString();
    this.sql`INSERT INTO threads (id, root_message_id, ack_message_id, title, status, status_text, resolved, label, cli, created_at, updated_at)
      VALUES (${id}, ${rootMessageId}, ${ackMessageId}, ${title}, ${"working"}, ${null}, 0, ${null}, ${cli ? JSON.stringify(cli) : null}, ${now}, ${now})`;
    const thread = this.getThread(id)!;
    this.emit({ type: "thread.updated", thread });
    this.syncActivity();
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
    // A close reason only describes a closed thread: reopening it, or resolving it the usual way, clears it.
    if (!next.resolved || (patch.resolved && patch.closeReason === undefined)) {
      next.closeReason = null;
      next.duplicateOf = null;
    }
    this.sql`UPDATE threads SET title = ${next.title}, status = ${next.status}, status_text = ${next.statusText},
      resolved = ${next.resolved ? 1 : 0}, close_reason = ${next.closeReason}, duplicate_of = ${next.duplicateOf},
      label = ${next.label}, cli = ${next.cli ? JSON.stringify(next.cli) : null}, updated_at = ${next.updatedAt} WHERE id = ${id}`;
    this.emit({ type: "thread.updated", thread: next });
    this.syncActivity();
    return next;
  }

  /**
   * Closes a thread that should not have been opened, without deleting anything: its running turn
   * stops, its routines pause, and the card reads closed with the reason. Writing in it reopens it.
   * The coordinator may only close a thread that has produced nothing a person could miss; anything
   * else is the person's call.
   */
  async closeThread(
    threadId: string,
    input: { reason: ThreadCloseReason; duplicateOf?: string; note?: string; by: "coordinator" | "person" },
  ): Promise<Thread> {
    const thread = this.getThread(threadId);
    if (!thread) throw new Error(`No thread ${threadId}.`);
    const original = input.duplicateOf ? this.getThread(input.duplicateOf) : null;
    if (input.duplicateOf && (!original || original.id === thread.id)) throw new Error(`No other thread ${input.duplicateOf}.`);
    if (input.by === "coordinator") {
      if (thread.resolved) throw new Error(`"${thread.title}" is already resolved; leave it.`);
      const kept = await this.closeBlockers(thread);
      if (kept.length) {
        throw new Error(
          `"${thread.title}" already has ${kept.join(", ")}, so only a person can close it. Leave it open; if it looks like a mistake, ask through message_thread so the thread puts it to the person.`,
        );
      }
    }
    for (const r of this.listRoutines()) {
      if (r.target.kind === "thread" && r.target.threadId === thread.id && !r.paused) this.updateRoutine(r.id, { paused: true });
    }
    const agent = await getAgentByName(this.env.THREAD_AGENT, thread.id);
    await agent.close();
    const closed = this.updateThread(thread.id, {
      status: "done",
      resolved: true,
      closeReason: input.reason,
      duplicateOf: original?.id ?? null,
    })!;
    this.setActivity(thread.id, false);
    if (input.note) this.sendMessage({ threadId: thread.id, authorKind: "system", authorId: SYSTEM_ID, body: input.note });
    return closed;
  }

  /** What a thread made that closing it could hide from people: pull requests, artifacts, routines, their own messages. */
  private async closeBlockers(thread: Thread): Promise<string[]> {
    const kept: string[] = [];
    if ((await listPullRequests(this.env.DB, this.name, thread.id)).length) kept.push("a pull request");
    if (this.artifacts.list().some((a) => a.threadId === thread.id)) kept.push("an artifact");
    if (this.listRoutines().some((r) => r.target.kind === "thread" && r.target.threadId === thread.id)) kept.push("a routine");
    const [people] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM messages WHERE thread_id = ${thread.id} AND author_kind = 'user'`;
    if (people!.n > 0) kept.push("messages from people");
    return kept;
  }

  /**
   * A recent thread whose ask is the same as this message's: same person, same words, within
   * DUPLICATE_WINDOW_MS, not itself closed. Catches an ask sent again before its card showed up.
   */
  findDuplicateThread(messageId: string): Thread | null {
    const message = this.getMessage(messageId);
    if (!message || message.authorKind !== "user") return null;
    const words = sameAsk(message.body);
    if (!words) return null;
    const since = Date.parse(message.createdAt) - DUPLICATE_WINDOW_MS;
    return (
      this.listThreads().findLast((t) => {
        if (t.closeReason || t.rootMessageId === messageId || Date.parse(t.createdAt) < since) return false;
        const root = this.getMessage(t.rootMessageId);
        return root?.authorKind === "user" && root.authorId === message.authorId && sameAsk(root.body) === words;
      }) ?? null
    );
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
    return {
      projectName,
      thread,
      root,
      messages,
      names,
      knowledge: this.knowledge.snapshot(),
      routines: this.listRoutines(),
      defaultTimezone: this.defaultTimezone(),
    };
  }

  /** This server's public address (for links and for the sandbox to call back), or null before anyone connected. Callable over RPC. */
  publicOrigin(): string | null {
    return this.env.BETTER_AUTH_URL?.replace(/\/$/, "") || (this.ctx.storage.kv.get<string>("origin") ?? null);
  }

  /** A thread's turn ended in a way people should hear about. Callable over RPC. */
  async notifyThread(threadId: string, kind: NotificationKind, text: string): Promise<void> {
    const thread = this.getThread(threadId);
    if (!thread) return;
    try {
      const { projectName } = await this.directory();
      const origin = this.publicOrigin();
      await deliverNotification(this.env, {
        projectId: this.name,
        projectName,
        threadId,
        kind,
        title: thread.title,
        body: excerpt(text),
        path: `/projects/${this.name}/threads/${threadId}`,
        origin,
      });
    } catch (err) {
      console.error("notification failed", err);
    }
  }

  /** A thread agent asks the coordinator for permission or direction. Callable over RPC. */
  async requestCoordinator(threadId: string, kind: CoordinatorRequestKind, reason: string): Promise<void> {
    await this.notifyCoordinator({ kind: "request", threadId, request: kind, reason });
  }

  override onStart(): void {
    // Activity lives in memory, so a restart (an eviction or a crash mid-turn) clears whatever was left in D1.
    this.syncActivity();
  }

  /** Agents report when they start and stop working, and optionally what they are doing. Callable over RPC. */
  setActivity(threadId: string | null, active: boolean, label?: string): void {
    // A stop always goes out: the map lives in memory and is empty again after the object was evicted
    // mid-turn, and skipping the stop then left clients showing "Thinking" for good.
    if (active && this.active.has(threadId) && label === this.active.get(threadId)) return;
    if (active) this.active.set(threadId, label);
    else this.active.delete(threadId);
    this.emit({ type: "agent.activity", threadId, active, label });
    this.syncActivity();
  }

  /**
   * Copies how many agents are working and how many threads wait on a person into the project's D1 row,
   * so the project list can show it without waking every project. Only writes when the counts change.
   */
  private syncActivity(): void {
    const working = new Set<string>();
    for (const threadId of this.active.keys()) working.add(threadId ?? "coordinator");
    let waiting = 0;
    for (const row of this.sql<{ id: string; status: ThreadStatus }>`
      SELECT id, status FROM threads WHERE resolved = 0 AND status IN ('working', 'blocked')`) {
      if (row.status === "working") working.add(row.id);
      else waiting++;
    }
    const counts = { activeCount: working.size, waitingCount: waiting };
    const key = `${counts.activeCount}/${counts.waitingCount}`;
    if (key === this.syncedActivity) return;
    this.syncedActivity = key;
    // Chained so an older count never lands after a newer one.
    this.activityWrite = this.activityWrite.then(async () => {
      try {
        await createDb(this.env.DB).update(schema.projects).set(counts).where(eq(schema.projects.id, this.name));
      } catch (err) {
        console.error("project activity sync failed", err);
        if (this.syncedActivity === key) this.syncedActivity = null;
      }
    });
    this.ctx.waitUntil(this.activityWrite);
  }

  /** The project's local folder changed or its computer connected/disconnected. Callable over RPC. */
  workspaceChanged(): void {
    this.emit({ type: "workspace.changed" });
  }

  /** A thread's task changed or printed output; relay it to clients. Callable over RPC. */
  broadcastTask(event: Extract<ServerEvent, { type: "task.updated" | "task.output" }>): void {
    this.emit(event);
  }

  /** A pull request a thread opened changed on GitHub; relay it to clients. Callable over RPC. */
  broadcastPullRequest(pullRequest: PullRequest): void {
    this.emit({ type: "pr.updated", pullRequest });
  }

  // ---- Routines ----------------------------------------------------------

  listRoutines(): Routine[] {
    return this.sql<RoutineRow>`SELECT * FROM routines ORDER BY created_at`.map((r) => this.toRoutine(r));
  }

  getRoutine(id: string): Routine | null {
    const [row] = this.sql<RoutineRow>`SELECT * FROM routines WHERE id = ${id}`;
    return row ? this.toRoutine(row) : null;
  }

  /** Creates and arms a routine. Callable over RPC. Throws on a bad target or a time in the past. */
  async createRoutine(input: CreateRoutineInput, createdBy: string): Promise<Routine> {
    this.checkTarget(input.target);
    this.checkSchedule(input.schedule);
    const id = createId("routine");
    const now = new Date().toISOString();
    this.sql`INSERT INTO routines (id, name, prompt, target, schedule, paused, run_count, created_by, created_at)
      VALUES (${id}, ${input.name}, ${input.prompt}, ${JSON.stringify(input.target)}, ${JSON.stringify(input.schedule)},
        0, 0, ${createdBy}, ${now})`;
    return this.arm(id);
  }

  /**
   * Renames, reschedules, pauses or resumes a routine. Callable over RPC. Whoever changes its prompt
   * (`editedBy`) answers for it from then on: its runs work as them (see fireRoutine).
   */
  async updateRoutine(id: string, patch: UpdateRoutineInput, editedBy?: string): Promise<Routine | null> {
    const current = this.getRoutine(id);
    if (!current) return null;
    if (patch.schedule) this.checkSchedule(patch.schedule);
    const next = { ...current, ...patch };
    const by = editedBy && patch.prompt !== undefined && patch.prompt !== current.prompt ? editedBy : current.createdBy;
    this.sql`UPDATE routines SET name = ${next.name}, prompt = ${next.prompt}, schedule = ${JSON.stringify(next.schedule)},
      paused = ${next.paused ? 1 : 0}, created_by = ${by} WHERE id = ${id}`;
    return this.arm(id);
  }

  async deleteRoutine(id: string): Promise<boolean> {
    const [row] = this.sql<RoutineRow>`SELECT * FROM routines WHERE id = ${id}`;
    if (!row) return false;
    if (row.schedule_id) await this.cancelSchedule(row.schedule_id);
    this.sql`DELETE FROM routines WHERE id = ${id}`;
    this.emit({ type: "routine.deleted", routineId: id });
    return true;
  }

  /** Runs a routine right away without touching its schedule. Callable over RPC. */
  async runRoutineNow(id: string): Promise<Routine | null> {
    const routine = this.getRoutine(id);
    if (!routine) return null;
    await this.fireRoutine(routine);
    return this.getRoutine(id);
  }

  /** Schedule callback (a DO alarm via the Agents SDK): run the routine, then arm its next run. */
  async runRoutine(payload: { routineId: string }): Promise<void> {
    const routine = this.getRoutine(payload.routineId);
    if (!routine || routine.paused) return;
    this.sql`UPDATE routines SET schedule_id = NULL WHERE id = ${routine.id}`;
    await this.fireRoutine(routine);
    if (routine.schedule.kind === "cron") {
      await this.arm(routine.id);
      return;
    }
    // A one-off routine is finished once its alarm has fired.
    this.sql`UPDATE routines SET next_run_at = NULL WHERE id = ${routine.id}`;
    this.emit({ type: "routine.updated", routine: this.getRoutine(routine.id)! });
  }

  private async fireRoutine(routine: Routine) {
    const now = new Date().toISOString();
    this.sql`UPDATE routines SET last_run_at = ${now}, run_count = run_count + 1 WHERE id = ${routine.id}`;
    if (routine.target.kind === "thread") {
      const thread = this.getThread(routine.target.threadId);
      if (thread) {
        const reopened = thread.resolved;
        if (reopened) this.updateThread(thread.id, { resolved: false });
        // The run works for the routine's author, not for whoever wrote in the thread last: a member's
        // routine must not reach another member's own connectors or computer.
        const actor = routine.createdBy === "agent" ? undefined : routine.createdBy;
        await this.wakeThread(thread.id, { kind: "routine", name: routine.name, prompt: routine.prompt, actor, reopened });
        return;
      }
      // The thread is gone: hand the run to the coordinator instead of dropping it.
    }
    const post = this.sendMessage({
      threadId: null,
      authorKind: "system",
      authorId: ROUTINE_ID,
      body: `⏰ ${routine.name}\n\n${routine.prompt}`,
    });
    await this.notifyCoordinator({ kind: "routine", messageId: post.id, routineId: routine.id, name: routine.name });
  }

  /** Cancels the pending alarm, computes the next run and schedules it. Emits the new state. */
  private async arm(id: string): Promise<Routine> {
    const [row] = this.sql<RoutineRow>`SELECT * FROM routines WHERE id = ${id}`;
    if (row!.schedule_id) await this.cancelSchedule(row!.schedule_id);
    const routine = this.toRoutine(row!);
    const next = routine.paused ? null : nextRun(routine.schedule, routine.lastRunAt);
    let scheduleId: string | null = null;
    if (next) {
      const s = await this.schedule(next, "runRoutine", { routineId: id }, { idempotent: false });
      scheduleId = s.id;
    }
    const nextRunAt = next?.toISOString() ?? null;
    this.sql`UPDATE routines SET next_run_at = ${nextRunAt}, schedule_id = ${scheduleId} WHERE id = ${id}`;
    const armed = { ...routine, nextRunAt };
    this.emit({ type: "routine.updated", routine: armed });
    return armed;
  }

  private checkTarget(target: RoutineTarget) {
    if (target.kind === "thread" && !this.getThread(target.threadId)) throw new Error("That thread does not exist.");
  }

  private checkSchedule(schedule: RoutineSchedule) {
    if (schedule.kind === "once" && Date.parse(schedule.at) <= Date.now()) {
      throw new Error("That time is already in the past.");
    }
    if (schedule.kind === "cron" && !nextCronRun(schedule.cron, schedule.timezone, new Date())) {
      throw new Error("That cron expression never matches.");
    }
  }

  private defaultTimezone() {
    return this.env.DEFAULT_TIMEZONE || "UTC";
  }

  /** The coordinator's routine tools. Routines agents create are credited to "agent". */
  private routineHost(threadId: string | null): RoutineHost {
    return {
      listRoutines: () => this.listRoutines(),
      createRoutine: (input) => this.createRoutine(input, "agent"),
      setPaused: (id, paused) => this.updateRoutine(id, { paused }),
      deleteRoutine: (id) => this.deleteRoutine(id),
      defaultTimezone: this.defaultTimezone(),
      threadId,
    };
  }

  private async wakeThread(threadId: string, reason: ThreadWake) {
    const agent = await getAgentByName(this.env.THREAD_AGENT, threadId);
    await agent.wake(reason);
  }

  // ---- Artifacts ---------------------------------------------------------

  /**
   * Publish a new artifact, or a new version of one. Callable over RPC. Bad input comes
   * back as `error` (a message for the model) rather than an exception across RPC.
   */
  async publishArtifact(input: PublishInput): Promise<{ artifact: Artifact } | { error: string }> {
    try {
      const artifact = await this.artifacts.publish(input);
      this.emit({ type: "artifact.updated", artifact });
      return { artifact };
    } catch (err) {
      if (err instanceof ArtifactError) return { error: err.message };
      throw err;
    }
  }

  /** Newest first. Callable over RPC. */
  listArtifacts(): Artifact[] {
    return this.artifacts.list();
  }

  getArtifact(id: string): { artifact: Artifact; versions: ArtifactVersion[] } | null {
    const artifact = this.artifacts.get(id);
    return artifact ? { artifact, versions: this.artifacts.versions(id) } : null;
  }

  hasArtifactVersion(id: string, version: number): boolean {
    return this.artifacts.hasVersion(id, version);
  }

  // ---- Deletion ---------------------------------------------------------

  /**
   * Called when the project is deleted (see src/projects/delete.ts): disconnects every client
   * and returns what lives outside this object, so the caller can clean it up.
   */
  prepareDelete(): { threadIds: string[]; artifactIds: string[] } {
    for (const connection of this.getConnections()) connection.close(4404, "project deleted");
    return { threadIds: this.listThreads().map((t) => t.id), artifactIds: this.artifacts.list().map((a) => a.id) };
  }

  /** Erases this project's storage and pending alarms. */
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ---- Coordinator -------------------------------------------------------

  /**
   * Whether the coordinator should see a thread message: what a person writes there and the thread
   * agent's replies, while another thread is open that it could matter to. Plan cards, plan update
   * notes and attachment-only messages carry nothing to relay.
   */
  private observable(m: Message): m is Message & { threadId: string } {
    if (!m.threadId || !m.body.trim() || isPlanMessage(m.body)) return false;
    if (m.authorKind !== "user" && !(m.authorKind === "agent" && m.authorId === THREAD_AGENT_ID)) return false;
    return this.listThreads().some((t) => !t.resolved && t.id !== m.threadId);
  }

  private async observeThread(m: Message & { threadId: string }) {
    const item: InboxItem = { kind: "thread", threadId: m.threadId, messageId: m.id };
    this.sql`INSERT INTO coordinator_inbox (kind, payload) VALUES (${item.kind}, ${JSON.stringify(item)})`;
    // One pending look at a time; any coordinator turn before it takes these items too.
    await this.schedule(OBSERVE_DELAY_SEC, "coordinatorTurn", "observe", { idempotent: true });
  }

  private recentRelays(): Relay[] {
    return this.sql<{ from_thread_id: string; to_thread_id: string; note: string; created_at: string }>`
      SELECT * FROM (SELECT * FROM coordinator_relays ORDER BY id DESC LIMIT ${RELAY_HISTORY}) ORDER BY id`.map((r) => ({
      fromThreadId: r.from_thread_id,
      toThreadId: r.to_thread_id,
      note: r.note,
      createdAt: r.created_at,
    }));
  }

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

    const allowed = await canUseCoordinator(this.env, this.name);
    if (!allowed.ok) {
      this.sendMessage({ threadId: null, authorKind: "system", authorId: SYSTEM_ID, body: allowed.reason });
      return;
    }
    const llm = await projectProvider(this.env, this.name);
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
      const meter = new TurnMeter(llm.provider.model);
      const threadUpdates = inbox.flatMap((item) => {
        if (item.kind !== "thread") return [];
        const thread = this.getThread(item.threadId);
        const message = this.getMessage(item.messageId);
        return thread && message ? [{ thread, message }] : [];
      });
      const onlyThreadUpdates = inbox.every((i) => i.kind === "thread");
      // Picking among the CLIs an ask offers goes by how much of their limits the computer reports used.
      const fresh = new Set(inbox.flatMap((i) => (i.kind === "message" ? [i.messageId] : [])));
      const choosing = chat.some((m) => fresh.has(m.id) && (m.clis?.length ?? 0) > 1);
      const computerClis = choosing ? ((await workspaceClis(this.env, this.name))?.clis ?? []) : undefined;
      await runLoop({
        provider: meteredForTurn(
          llm.provider,
          this.env,
          { projectId: this.name, threadId: null, userId: this.turnRequester(inbox), agent: "coordinator" },
          meter,
        ),
        system: COORDINATOR_SYSTEM,
        prompt: coordinatorPrompt({
          projectName,
          names,
          chat,
          threads: this.listThreads(),
          routines: this.listRoutines(),
          inbox,
          threadUpdates,
          relays: this.recentRelays(),
          knowledge: this.knowledge.snapshot(),
          now: new Date(),
          defaultTimezone: this.defaultTimezone(),
          computerClis,
        }),
        tools: [
          ...coordinatorTools(this.coordinatorHost(meter, this.forwardedFor(inbox)), this.knowledgeHost({ kind: "agent", id: COORDINATOR_ID }), {
            onlyThreadUpdates,
          }),
          ...(onlyThreadUpdates ? [] : routineTools(this.routineHost(null))),
        ],
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

  /** The person whose message this coordinator turn answers, for usage attribution. */
  private turnRequester(inbox: InboxItem[]): string | null {
    for (const item of inbox) {
      const m = item.kind === "message" ? this.getMessage(item.messageId) : null;
      if (m?.authorKind === "user") return m.authorId;
    }
    return null;
  }

  /**
   * Who a follow-up this coordinator turn forwards to a thread is for: the one person whose project
   * chat messages (or routine) it answers. Null when that is not one person (several wrote, or no
   * one did), so the thread then works without anyone's own computer or connectors rather than
   * with those of whoever wrote in it before. Decided here from the inbox, never by the model.
   */
  private forwardedFor(inbox: InboxItem[]): string | null {
    const people = new Set<string>();
    for (const item of inbox) {
      if (item.kind === "message") {
        const m = this.getMessage(item.messageId);
        if (m?.authorKind === "user") people.add(m.authorId);
      } else if (item.kind === "routine") {
        const routine = this.getRoutine(item.routineId);
        people.add(routine && routine.createdBy !== "agent" ? routine.createdBy : "");
      }
    }
    const [only] = people;
    return people.size === 1 && only ? only : null;
  }

  private coordinatorHost(meter?: TurnMeter, forwardedFor: string | null = null): CoordinatorHost {
    const post = (body: string, relay?: MessageRelay) =>
      this.sendMessage({
        threadId: null,
        authorKind: "agent",
        authorId: COORDINATOR_ID,
        body,
        ...(relay && { relay }),
        ...(meter && { stats: meter.take() ?? undefined }),
      });
    // The line in the thread where a note arrived, so people can open what the coordinator said.
    const relayInThread = (relay: MessageRelay, body: string) =>
      this.sendMessage({ threadId: relay.threadId, authorKind: "agent", authorId: COORDINATOR_ID, body, relay });
    return {
      getMessage: (id) => this.getMessage(id),
      getThread: (id) => this.getThread(id),
      threadForRoot: (messageId) => this.listThreads().find((t) => t.rootMessageId === messageId) ?? null,
      post,
      react: (messageId, emoji) => this.addReaction({ messageId, emoji, authorKind: "agent", authorId: COORDINATOR_ID }),
      startThread: async ({ rootMessageId, title, brief, ack, projectAck, cli }) => {
        // The id comes first so the "on it" line can carry the brief before the thread exists.
        const relay: MessageRelay = { kind: "brief", threadId: createId("thread"), note: brief };
        // The project-chat line goes first so the card can sit under it: ask, "on it", card.
        const ackMessage = projectAck ? post(projectAck, relay) : null;
        const thread = this.createThread(rootMessageId, title, ackMessage?.id ?? null, relay.threadId, cli ?? null);
        relayInThread(relay, ack || relayLine("brief", brief));
        const agent = await getAgentByName(this.env.THREAD_AGENT, thread.id);
        await agent.start({ projectId: this.name, threadId: thread.id, brief });
        return thread;
      },
      findDuplicate: (messageId) => this.findDuplicateThread(messageId),
      closeThread: (threadId, input) => this.closeThread(threadId, { ...input, by: "coordinator" }),
      messageThread: async (threadId, note, kind) => {
        const thread = this.getThread(threadId);
        // Reopened right away, so the card stops reading "Resolved" before the thread's turn starts.
        const reopened = !!thread?.resolved;
        if (reopened) this.updateThread(threadId, { resolved: false, status: "working" });
        relayInThread({ kind, threadId, note }, relayLine(kind, note));
        // A forwarded ask works for whoever asked it; an answer to the thread's own request changes nothing.
        await this.wakeThread(threadId, { kind: "coordinator", note, reopened, ...(kind === "follow_up" && { forwardedFor }) });
      },
      relay: async (fromThreadId, toThreadId, note) => {
        const from = this.getThread(fromThreadId);
        const to = this.getThread(toThreadId);
        if (!from) throw new Error(`No thread ${fromThreadId}.`);
        if (!to) throw new Error(`No thread ${toThreadId}.`);
        if (from.id === to.id) throw new Error("A thread already knows its own work; relay only to another thread.");
        // A finished thread is not woken for news; redoing its work is a new ask from a person.
        if (to.resolved) throw new Error(`"${to.title}" is resolved; do not relay to it.`);
        const since = new Date(Date.now() - RELAY_COOLDOWN_MS).toISOString();
        const [recent] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM coordinator_relays WHERE created_at > ${since}
          AND ((from_thread_id = ${from.id} AND to_thread_id = ${to.id}) OR (from_thread_id = ${to.id} AND to_thread_id = ${from.id}))`;
        if (recent!.n > 0) {
          throw new Error(`You already relayed between "${from.title}" and "${to.title}" in the last few minutes; do not relay again.`);
        }
        this.sql`INSERT INTO coordinator_relays (from_thread_id, to_thread_id, note, created_at)
          VALUES (${from.id}, ${to.id}, ${note}, ${new Date().toISOString()})`;
        relayInThread({ kind: "relay", threadId: to.id, fromThreadId: from.id, note }, relayLine("relay", note, from.title));
        await this.wakeThread(to.id, { kind: "coordinator", note: `From the "${from.title}" thread: ${note}` });
      },
    };
  }

  // ---- Knowledge (instructions, memory, files) ---------------------------
  // Thin RPC surface over KnowledgeStore for the API routes and thread agents.

  getInstructions() {
    return this.knowledge.getInstructions();
  }

  setInstructions(text: string, by: Author) {
    return this.knowledge.setInstructions(text, by);
  }

  listMemory() {
    return this.knowledge.listMemory();
  }

  getMemory(name: string) {
    return this.knowledge.getMemory(name);
  }

  putMemory(name: string, input: { description: string; content: string }, by: Author) {
    return this.knowledge.putMemory(name, input, by);
  }

  deleteMemory(name: string) {
    return this.knowledge.deleteMemory(name);
  }

  listFiles(prefix = "") {
    return this.knowledge.listFiles(prefix);
  }

  getFile(path: string) {
    return this.knowledge.getFile(path);
  }

  recordFile(file: { path: string; size: number; contentType: string }, by: Author) {
    return this.knowledge.recordFile(file, by);
  }

  /** Bytes the project's files take, leaving out `except`. Callable over RPC. */
  filesBytes(except?: string) {
    return this.knowledge.filesBytes(except);
  }

  forgetFile(path: string) {
    return this.knowledge.forgetFile(path);
  }

  /** Attachments for a message, from project file paths; throws on a path with no file. */
  attachmentsFor(paths: string[]) {
    return this.knowledge.attachmentsFor(paths.map(normalizeFilePath));
  }

  async readFileText(path: string): Promise<{ found: boolean; text: string | null; size: number }> {
    const file = this.knowledge.getFile(path);
    if (!file) return { found: false, text: null, size: 0 };
    return { found: true, text: await this.knowledge.readText(path), size: file.size };
  }

  writeFileText(path: string, content: string, by: Author) {
    return this.knowledge.writeText(path, content, by);
  }

  private knowledgeHost(by: Author): KnowledgeHost {
    return {
      memoryRead: (name) => this.getMemory(name),
      memoryWrite: (name, description, content) => this.putMemory(name, { description, content }, by),
      memoryDelete: (name) => this.deleteMemory(name),
      listFiles: (prefix) => this.listFiles(prefix),
      readText: (path) => this.readFileText(path),
      writeText: (path, content) => this.writeFileText(path, content, by),
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

  /** When open connections last had their session and membership checked (see recheckConnections). */
  private connectionsCheckedAt = Date.now();

  /**
   * Closes connections whose session was signed out or revoked, or whose person left, since they
   * connected: a connection that only listens is never checked by onMessage. At most once a minute.
   */
  private recheckConnections() {
    if (Date.now() - this.connectionsCheckedAt < 60_000) return;
    this.connectionsCheckedAt = Date.now();
    const open = [...this.getConnections<ConnState>()].filter((c) => c.state);
    this.ctx.waitUntil(
      Promise.all(
        open.map(async (c) => {
          if (!(await this.stillAllowed(c.state!))) c.close(4401, "unauthorized");
        }),
      ).catch((err) => console.warn("checking connections failed", err)),
    );
  }

  private emit(event: ServerEvent) {
    this.recheckConnections();
    const now = Date.now();
    const expired: string[] = [];
    for (const c of this.getConnections<ConnState>()) {
      if (!c.state || c.state.expiresAt <= now) {
        c.close(4401, "session expired");
        expired.push(c.id);
      }
    }
    this.broadcast(JSON.stringify(event), expired);
  }

  /** Whether a connection's person is still a member, signed in with the session they connected with. */
  private async stillAllowed(state: ConnState): Promise<boolean> {
    if (state.expiresAt <= Date.now()) return false;
    const row = await this.env.DB.prepare(
      `SELECT 1 AS ok FROM session s JOIN project_members m ON m.user_id = s.user_id
       WHERE s.id = ?1 AND s.user_id = ?2 AND s.expires_at > ?3 AND m.project_id = ?4`,
    )
      .bind(state.sessionId, state.userId, Date.now(), this.name)
      .first<{ ok: number }>();
    return Boolean(row);
  }

  /** Closes a person's connections: they left the project or were removed from it. Callable over RPC. */
  disconnectUser(userId: string): void {
    for (const c of this.getConnections<ConnState>()) {
      if (c.state?.userId === userId) c.close(4403, "no longer a member");
    }
  }

  private toMessage(r: MessageRow): Message {
    return {
      id: r.id,
      projectId: this.name,
      threadId: r.thread_id,
      authorKind: r.author_kind,
      authorId: r.author_id,
      body: r.body,
      attachments: r.attachments ? (JSON.parse(r.attachments) as Attachment[]) : [],
      ...(r.artifacts && { artifacts: JSON.parse(r.artifacts) as ArtifactRef[] }),
      ...(r.stats && { stats: JSON.parse(r.stats) as MessageStats }),
      ...(r.relay && { relay: JSON.parse(r.relay) as MessageRelay }),
      ...(r.clis && { clis: JSON.parse(r.clis) as string[] }),
      seq: r.seq,
      createdAt: r.created_at,
    };
  }

  private toThread(r: ThreadRow): Thread {
    return {
      id: r.id,
      projectId: this.name,
      rootMessageId: r.root_message_id,
      ackMessageId: r.ack_message_id ?? null,
      title: r.title,
      status: r.status,
      statusText: r.status_text,
      resolved: r.resolved === 1,
      closeReason: r.close_reason ?? null,
      duplicateOf: r.duplicate_of ?? null,
      label: r.label,
      cli: r.cli ? (JSON.parse(r.cli) as ThreadCli) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private toRoutine(r: RoutineRow): Routine {
    return {
      id: r.id,
      projectId: this.name,
      name: r.name,
      prompt: r.prompt,
      target: JSON.parse(r.target) as Routine["target"],
      schedule: JSON.parse(r.schedule) as Routine["schedule"],
      paused: r.paused === 1,
      nextRunAt: r.next_run_at,
      lastRunAt: r.last_run_at,
      runCount: r.run_count,
      createdBy: r.created_by,
      createdAt: r.created_at,
    };
  }
}

/** An ask reduced to its words, so a resend with other casing, spacing or punctuation still matches. */
function sameAsk(body: string): string {
  return body
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** When a routine runs next: the next cron match, or a one-off time that has not run yet. */
function nextRun(schedule: RoutineSchedule, lastRunAt: string | null): Date | null {
  if (schedule.kind === "cron") return nextCronRun(schedule.cron, schedule.timezone, new Date());
  const at = new Date(schedule.at);
  return lastRunAt && Date.parse(lastRunAt) >= at.getTime() - 1000 ? null : at;
}

/** Why a thread agent is woken. */
/** reopened: the thread was resolved and this wake opens it again, so its work starts a new round with its own plan card. */
export type ThreadWake =
  /** body, authorId, seq: a person's message, which may answer a question the running turn waits on. */
  | { kind: "message"; messageId: string; body?: string; authorId?: string; seq?: number; reopened?: boolean }
  /**
   * forwardedFor: set when the note forwards a person's ask from the project chat: who asked (see
   * ProjectAgent.forwardedFor), or null when that is not one known person.
   */
  | { kind: "coordinator"; note: string; reopened?: boolean; forwardedFor?: string | null }
  /** actor: the person the routine works for (its author); none for one an agent made for its thread. */
  | { kind: "routine"; name: string; prompt: string; actor?: string; reopened?: boolean }
  /**
   * Something happened on a pull request the thread opened (github/pulls.ts). settled: it was merged
   * or closed, which needs no turn of its own unless the thread's plan still has work.
   */
  | { kind: "github"; event: string; settled?: { pr: string; merged: boolean } };

function send(connection: Connection, event: ServerEvent) {
  connection.send(JSON.stringify(event));
}
