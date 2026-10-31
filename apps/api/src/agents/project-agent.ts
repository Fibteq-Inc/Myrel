import { reportError } from "../errors";
import { createDb, schema } from "@myrel/db";
import {
  type Attachment,
  type Artifact,
  type ArtifactVersion,
  type AuthorKind,
  type CliId,
  CloudCli,
  TaskTarget,
  ClientEvent,
  type CreateRoutineInput,
  createId,
  type MarkMemoryInput,
  MEMORY_INDEX,
  MemoryUpkeepMode,
  type MemoryUpkeepState,
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
  CLOUD_RUNNER,
  SYNC_PAGE_SIZE,
  CONVERSATION_PAGE_SIZE,
  type ConversationPage,
  type Thread,
  type ThreadCli,
  type ThreadRunner,
  type ThreadModel,
  type ThreadCloseReason,
  type ThreadStatus,
  type ThreadSummary,
  summarizeThread,
  type UpdateRoutineInput,
} from "@myrel/protocol";
import { Agent, type Connection, type ConnectionContext, getAgentByName } from "agents";
import { and, eq } from "drizzle-orm";
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
  offeredFor,
  COORDINATOR_SYSTEM,
  type FinishedThread,
  type InboxItem,
  onlyObserving,
  type Relay,
} from "./coordinator";
import { type Author, type KnowledgeHost, type KnowledgeSnapshot, KnowledgeStore } from "./knowledge";
import { meteredForTurn, TurnMeter } from "../usage";
import {
  UPKEEP_KEYS,
  UPKEEP_THREADS,
  UPKEEP_TITLE,
  upkeepActive,
  upkeepBrief,
  upkeepDue,
  upkeepNotice,
} from "./memory-upkeep";
import { COORDINATOR_ID, MEMORY_UPKEEP_ID, ROUTINE_ID, SEEN_EMOJI, SYSTEM_ID, THREAD_AGENT_ID } from "./names";
import { answerLine, relayLine } from "./relay-line";
import { workspaceClis } from "../runners";
import { type RoutineHost, routineTools } from "./routine-tools";
import { GOAL_CHECK_SEC, GOAL_MAX_IDLE, GOAL_MAX_THREADS, GOAL_MAX_WAKES, type Goal, type GoalHost, goalTools } from "./goal";

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
  /** When its author last changed the text, or null. */
  edited_at: string | null;
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
  /** JSON ThreadModel, or null. */
  model: string | null;
  /** JSON ThreadRunner, or null. */
  runner: string | null;
  seen_seq: number | null;
  created_at: string;
  updated_at: string;
};

type InboxRow = { id: number; kind: InboxItem["kind"]; payload: string };
type GoalRow = { text: string; until_at: string; created_by: string; created_at: string; wakes: number; threads: number; idle: number };

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
  Pick<Thread, "title" | "status" | "statusText" | "resolved" | "closeReason" | "duplicateOf" | "label" | "cli" | "runner" | "model" | "seenSeq">
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

/** The thread agents' choice cards one coordinator turn took, and which of them it answered or passed on. */
type TurnQuestions = { open: Map<string, { threadId: string }>; settled: Set<string> };

/**
 * How long the coordinator waits after a message inside a thread before looking at thread updates,
 * so a burst of replies costs one turn. A project-chat message runs it right away and takes them too.
 */
const OBSERVE_DELAY_SEC = 60;
/** Relays the coordinator sees each turn, so it does not repeat one. */
const RELAY_HISTORY = 20;
/** Messages a client may catch up on after being away; past this it starts again from the newest ones. */
const RESYNC_LIMIT = 1000;

/** A relay between the same two threads (either way) within this window is refused, so notes cannot bounce. */
const RELAY_COOLDOWN_MS = 10 * 60 * 1000;
/** How many recent coordinator notes in threads are searched for mentions of a thread that finished. */
const MENTION_SCAN = 200;
/** How many of those mentions the coordinator sees per finished thread. */
const MENTION_LIMIT = 5;
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
  /** Each thread's summary, added up from its messages when first asked for and kept up as they change. */
  private summaries = new Map<string, ThreadSummary>();

  /** Activity counts last written to D1 for the project list, and the write in flight. */
  private syncedActivity: string | null = null;
  private activityWrite: Promise<void> = Promise.resolve();

  /**
   * The last coordinator inbox row a running turn has taken. In memory only, so a turn that dies
   * with the object (a deploy, an eviction) leaves its rows for the queue's retry to take again.
   */
  private coordinatorTaken = 0;
  /** Threads the running coordinator turn started or sent work to, to tell an idle goal wake. In memory only. */
  private coordinatorWork = 0;

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
    // Added with people editing their messages.
    if (!columns.some((c) => c.name === "edited_at")) this.sql`ALTER TABLE messages ADD COLUMN edited_at TEXT`;
    // A thread's messages, for its summary and (later) for paging a thread from its newest message.
    this.sql`CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, seq)`;
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
    // Added with picking a thread's model and effort.
    if (!threadColumns.some((c) => c.name === "model")) this.sql`ALTER TABLE threads ADD COLUMN model TEXT`;
    // Added with showing people's messages the agent has not taken in yet.
    if (!threadColumns.some((c) => c.name === "seen_seq")) this.sql`ALTER TABLE threads ADD COLUMN seen_seq INTEGER`;
    // Added with projects on several computers.
    if (!threadColumns.some((c) => c.name === "runner")) this.sql`ALTER TABLE threads ADD COLUMN runner TEXT`;
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
    // The standing goal a person asked the coordinator to keep working toward; at most one row.
    this.sql`CREATE TABLE IF NOT EXISTS coordinator_goal (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      text TEXT NOT NULL,
      until_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      wakes INTEGER NOT NULL DEFAULT 0,
      threads INTEGER NOT NULL DEFAULT 0,
      idle INTEGER NOT NULL DEFAULT 0
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
      case "message.edit": {
        const error = await this.editOwnMessage(event.messageId, userId, event.body);
        if (error) send(connection, { type: "error", code: "cannot_edit", message: error });
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
        const [cli] = await this.offeredClis(userId, [event.cli], false, thread.runner?.id);
        if (!cli) {
          return send(connection, {
            type: "error",
            code: "no_cli",
            message: "This thread cannot run with that CLI: in the cloud it takes OpenCode, Claude Code or Codex; on the project's computer only its owner picks, among the CLIs installed there.",
          });
        }
        this.updateThread(thread.id, { cli: { id: cli, options: [cli], by: "person", reason: null } });
        return;
      }
      case "thread.runner": {
        const thread = this.getThread(event.threadId);
        if (!thread) return send(connection, { type: "error", code: "no_thread", message: "Thread not found" });
        if (event.runnerId === null) {
          this.updateThread(thread.id, { runner: null });
          return;
        }
        // The cloud runs on nobody's computer, so any member sends a thread there.
        if (event.runnerId === CLOUD_RUNNER) {
          this.updateThread(thread.id, { runner: { id: CLOUD_RUNNER, by: "person", reason: null } });
          return;
        }
        // Like the CLI: a turn runs on a computer as its owner, so only they send a thread there.
        const computer = await workspaceClis(this.env, this.name, { runnerId: event.runnerId });
        if (computer?.ownerId !== userId) {
          return send(connection, {
            type: "error",
            code: "no_runner",
            message: "A thread can work only on one of this project's computers, and only the person whose computer it is can send it there.",
          });
        }
        this.updateThread(thread.id, { runner: { id: event.runnerId, by: "person", reason: null } });
        return;
      }
      case "thread.model": {
        const thread = this.getThread(event.threadId);
        if (!thread) return send(connection, { type: "error", code: "no_thread", message: "Thread not found" });
        if (event.model === null && event.effort === null) {
          this.updateThread(thread.id, { model: null });
          return;
        }
        // The same people as for the CLI: the model runs on that computer, with its owner's login.
        const [cli] = await this.offeredClis(userId, [event.cli], true, thread.runner?.id);
        if (!cli) {
          return send(connection, {
            type: "error",
            code: "no_cli",
            message: "Only the person whose computer runs this project can pick its model, and only for a CLI installed there.",
          });
        }
        this.updateThread(thread.id, { model: { cli, model: event.model, effort: event.effort } });
        return;
      }
      case "goal.stop": {
        if (!this.getGoal()) return;
        const { names } = await this.directory();
        this.endGoal(`${names[userId] ?? "Someone"} stopped the standing goal. The coordinator no longer carries on by itself.`);
        return;
      }
      case "sync": {
        const goal = this.getGoal();
        const threads = this.listThreads();
        const artifacts = this.artifacts.list();
        const routines = this.listRoutines();
        const [newest] = this.sql<{ seq: number | null }>`SELECT MAX(seq) AS seq FROM messages`;
        const lastSeq = newest?.seq ?? 0;
        // A client that asks for `recent` gets the project chat's newest messages; threads load when opened.
        // So does one that has been away so long that catching up would mean too many messages.
        if (event.recent && (event.afterSeq === 0 || this.countMessagesAfter(event.afterSeq) > RESYNC_LIMIT)) {
          const chat = this.getConversationPage(null, null, event.recent);
          send(connection, {
            type: "sync.result",
            messages: chat.messages,
            hasMore: false,
            threads,
            reactions: chat.reactions,
            artifacts,
            routines,
            goal,
            windows: [{ threadId: null, hasEarlier: chat.hasEarlier }],
            ...(event.afterSeq > 0 ? { reset: true } : {}),
            lastSeq,
          });
        } else {
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
              goal,
              ...(page.hasMore ? {} : { lastSeq }),
            });
            if (!event.all || !page.hasMore) break;
            afterSeq = page.messages.at(-1)!.seq;
          }
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
    if (message.threadId) this.threadMessageAdded(message);
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

  /**
   * One page of a conversation (null: the project chat), oldest first, ending just before `beforeSeq`
   * (null: at its newest message). A thread's oldest page also carries the message it opened from.
   * Callable over RPC.
   */
  getConversationPage(threadId: string | null, beforeSeq: number | null, limit = CONVERSATION_PAGE_SIZE): ConversationPage {
    const before = beforeSeq ?? Number.MAX_SAFE_INTEGER;
    const rows =
      threadId === null
        ? this.sql<MessageRow>`SELECT * FROM messages WHERE thread_id IS NULL AND seq < ${before} ORDER BY seq DESC LIMIT ${limit + 1}`
        : this.sql<MessageRow>`SELECT * FROM messages WHERE thread_id = ${threadId} AND seq < ${before} ORDER BY seq DESC LIMIT ${limit + 1}`;
    const hasEarlier = rows.length > limit;
    const messages = rows.slice(0, limit).reverse().map((r) => this.toMessage(r));
    const rootId = threadId && !hasEarlier ? this.getThread(threadId)?.rootMessageId : undefined;
    const root = rootId ? this.getMessage(rootId) : null;
    return { messages, hasEarlier, reactions: this.reactionsFor(messages.map((m) => m.id)), ...(root && { root }) };
  }

  /** A thread's messages that carry a stats line, for its usage breakdown. Callable over RPC. */
  threadStatsMessages(threadId: string): Message[] {
    return this.sql<MessageRow>`SELECT * FROM messages WHERE thread_id = ${threadId} AND stats IS NOT NULL ORDER BY seq`.map((r) =>
      this.toMessage(r),
    );
  }

  private countMessagesAfter(seq: number): number {
    const [row] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM messages WHERE seq > ${seq}`;
    return row?.n ?? 0;
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
    this.threadMessageChanged(message?.threadId ?? null);
    return message;
  }

  /**
   * A person changes the text of their own message. In the project chat the coordinator looks at it
   * (and marks it seen); in a thread the thread's agent wakes to it. Returns why it was refused, or null.
   */
  private async editOwnMessage(id: string, userId: string, body: string): Promise<string | null> {
    const current = this.getMessage(id);
    if (!current || current.authorKind !== "user" || current.authorId !== userId) return "You can only edit your own messages.";
    if (!body && !current.attachments?.length) return "Write something, or keep the old text.";
    if (body === current.body) return null;
    const editedAt = new Date().toISOString();
    this.sql`UPDATE messages SET body = ${body}, edited_at = ${editedAt} WHERE id = ${id}`;
    const message = this.getMessage(id)!;
    this.emit({ type: "message.updated", message });
    this.threadMessageChanged(message.threadId);
    if (message.threadId) {
      // A finished thread is not woken for a changed word; its agent sees the edit when it works again.
      const thread = this.getThread(message.threadId);
      if (!thread || thread.resolved) return null;
      await this.wakeThread(message.threadId, { kind: "message", messageId: id, edited: true });
    } else {
      await this.notifyCoordinator({ kind: "edited", messageId: id });
    }
    return null;
  }

  /** Replaces what an agent message's stats line says, e.g. with usage reported after it was sent. Callable over RPC. */
  setMessageStats(id: string, stats: MessageStats): Message | null {
    this.sql`UPDATE messages SET stats = ${JSON.stringify(stats)} WHERE id = ${id}`;
    const message = this.getMessage(id);
    if (message) this.emit({ type: "message.updated", message });
    this.threadMessageChanged(message?.threadId ?? null);
    return message;
  }

  // ---- Thread summaries ----------------------------------------------------

  /** What a thread's messages add up to (replies, usage, its plan card), so clients need not hold them all. */
  private threadSummary(threadId: string): ThreadSummary {
    let summary = this.summaries.get(threadId);
    if (!summary) {
      const rows = this.sql<Pick<MessageRow, "id" | "author_kind" | "body" | "stats">>`
        SELECT id, author_kind, body, stats FROM messages WHERE thread_id = ${threadId} ORDER BY seq`;
      summary = summarizeThread(
        rows.map((r) => ({ id: r.id, authorKind: r.author_kind, body: r.body, stats: r.stats ? (JSON.parse(r.stats) as MessageStats) : undefined })),
      );
      this.summaries.set(threadId, summary);
    }
    return summary;
  }

  /** A new message in a thread adds to its summary, and clients get the thread with it. */
  private threadMessageAdded(message: Message) {
    const threadId = message.threadId!;
    const current = this.summaries.get(threadId);
    if (current) {
      const added = summarizeThread([message]);
      const usage =
        current.usage && added.usage
          ? {
              tokens: current.usage.tokens + added.usage.tokens,
              durationMs: current.usage.durationMs + added.usage.durationMs,
              costMicros:
                current.usage.costMicros === null || added.usage.costMicros === null ? null : current.usage.costMicros + added.usage.costMicros,
            }
          : (current.usage ?? added.usage);
      this.summaries.set(threadId, {
        replies: current.replies + added.replies,
        usage,
        planMessageId: added.planMessageId ?? current.planMessageId,
      });
    }
    const thread = this.getThread(threadId);
    if (thread) this.emit({ type: "thread.updated", thread });
  }

  /** A message in a thread changed (its text or stats): the summary is added up again, and clients hear when it moved. */
  private threadMessageChanged(threadId: string | null) {
    if (!threadId) return;
    const before = this.summaries.get(threadId);
    this.summaries.delete(threadId);
    const thread = this.getThread(threadId);
    if (thread && JSON.stringify(thread.summary) !== JSON.stringify(before)) this.emit({ type: "thread.updated", thread });
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
  /**
   * The CLIs `userId` may pick for a thread out of `wanted`. A thread they start runs in the cloud
   * when the project always works there, has no local folder, or works on someone else's computer:
   * then any member picks among the cloud CLIs (CloudCli), which run in the thread's sandbox with
   * the project's model. Otherwise only the computer's owner picks, among the CLIs installed there.
   * `localOnly`: a pick that only means something on the computer (its model and effort).
   * `runnerId`: the computer the thread was set to (CLOUD_RUNNER: the cloud); else the person's own
   * among the project's, if any.
   */
  private async offeredClis(userId: string, wanted: CliId[], localOnly = false, runnerId?: string): Promise<CliId[]> {
    if (runnerId === CLOUD_RUNNER) return localOnly ? [] : [...new Set(wanted)].filter((c) => CloudCli.safeParse(c).success);
    const computer = await workspaceClis(this.env, this.name, runnerId ? { runnerId } : { ownerId: userId });
    if (!localOnly) {
      const [row] = await createDb(this.env.DB).select({ taskTarget: schema.projects.taskTarget }).from(schema.projects).where(eq(schema.projects.id, this.name));
      const target = TaskTarget.catch("auto").parse(row?.taskTarget);
      if (target === "cloud" || !computer || (target === "auto" && computer.ownerId !== userId)) {
        return [...new Set(wanted)].filter((c) => CloudCli.safeParse(c).success);
      }
    }
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
    runner: ThreadRunner | null = null,
  ): Thread {
    const now = new Date().toISOString();
    this.sql`INSERT INTO threads (id, root_message_id, ack_message_id, title, status, status_text, resolved, label, cli, runner, created_at, updated_at)
      VALUES (${id}, ${rootMessageId}, ${ackMessageId}, ${title}, ${"working"}, ${null}, 0, ${null}, ${cli ? JSON.stringify(cli) : null}, ${runner ? JSON.stringify(runner) : null}, ${now}, ${now})`;
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
      label = ${next.label}, cli = ${next.cli ? JSON.stringify(next.cli) : null}, runner = ${next.runner ? JSON.stringify(next.runner) : null},
      model = ${next.model ? JSON.stringify(next.model) : null}, seen_seq = ${next.seenSeq}, updated_at = ${next.updatedAt} WHERE id = ${id}`;
    this.emit({ type: "thread.updated", thread: next });
    this.syncActivity();
    // Every way a thread finishes passes here (its agent, a person, its pull requests merging), and
    // some post nothing the coordinator watches; threads waiting on it only hear of it from the coordinator.
    if (!current.resolved && next.resolved && !next.closeReason) {
      this.ctx.waitUntil(this.observeFinished(id));
      this.ctx.waitUntil(this.countForUpkeep(id).catch((err) => console.error("memory upkeep check failed", err)));
    }
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

  /**
   * A thread's messages after `seq`, and the earlier ones people edited after `editedAfter`, with the
   * members' names, for a running turn to take in. Callable over RPC.
   */
  async threadMessagesAfter(
    threadId: string,
    seq: number,
    editedAfter?: string,
  ): Promise<{ messages: Message[]; edited: Message[]; names: Record<string, string> }> {
    const messages = this.sql<MessageRow>`SELECT * FROM messages WHERE thread_id = ${threadId} AND seq > ${seq} ORDER BY seq`.map((r) =>
      this.toMessage(r),
    );
    const edited = editedAfter
      ? this.sql<MessageRow>`SELECT * FROM messages WHERE thread_id = ${threadId} AND seq <= ${seq} AND edited_at > ${editedAfter} ORDER BY seq`.map(
          (r) => this.toMessage(r),
        )
      : [];
    return { messages, edited, names: messages.length || edited.length ? (await this.directory()).names : {} };
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
      this.ctx.waitUntil(reportError(this.env, "agent", "notification", err));
    }
  }

  /** A thread agent asks the coordinator for permission or direction. Callable over RPC. */
  async requestCoordinator(threadId: string, kind: CoordinatorRequestKind, reason: string, actor: string | null = null): Promise<void> {
    await this.notifyCoordinator({ kind: "request", threadId, request: kind, reason, actor });
  }

  /**
   * A thread agent's choice card goes to the coordinator before people: it answers what the project
   * already settles and passes the rest on. Callable over RPC.
   */
  async askCoordinator(threadId: string, input: { questionId: string; question: string }): Promise<void> {
    await this.notifyCoordinator({ kind: "question", threadId, ...input });
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
   * Edits a routine: renames it, changes its prompt or target, reschedules it (a new schedule may
   * switch between cron and once), pauses or resumes it. Callable over RPC. Throws on a bad target or
   * a new time in the past; an unchanged schedule is kept even if its one-off time has passed. Whoever
   * changes its prompt or target (`editedBy`) answers for it from then on: its runs work as them (see
   * fireRoutine). Re-arming computes the next run from the resulting schedule.
   */
  async updateRoutine(id: string, patch: UpdateRoutineInput, editedBy?: string): Promise<Routine | null> {
    const current = this.getRoutine(id);
    if (!current) return null;
    const changed = <K extends keyof UpdateRoutineInput>(key: K) =>
      patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(current[key]);
    if (changed("target")) this.checkTarget(patch.target!);
    if (changed("schedule")) this.checkSchedule(patch.schedule!);
    const next = { ...current, ...patch };
    const by = editedBy && (changed("prompt") || changed("target")) ? editedBy : current.createdBy;
    this.sql`UPDATE routines SET name = ${next.name}, prompt = ${next.prompt}, target = ${JSON.stringify(next.target)},
      schedule = ${JSON.stringify(next.schedule)}, paused = ${next.paused ? 1 : 0}, created_by = ${by} WHERE id = ${id}`;
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
      // A prompt or target the coordinator rewrites is the agent's from then on, not a member's.
      updateRoutine: (id, patch) => this.updateRoutine(id, patch, "agent"),
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

  private async observeFinished(threadId: string) {
    const othersOpen = this.listThreads().some((t) => !t.resolved && t.id !== threadId);
    const goal = this.openGoal();
    if (!othersOpen && !goal) return;
    const item: InboxItem = { kind: "finished", threadId };
    this.sql`INSERT INTO coordinator_inbox (kind, payload) VALUES (${item.kind}, ${JSON.stringify(item)})`;
    // The last open thread finishing is an open goal's cue: the coordinator wakes with its full tools to start what is next.
    if (goal && !othersOpen) {
      const wake: InboxItem = { kind: "goal", reason: "idle" };
      this.sql`INSERT INTO coordinator_inbox (kind, payload) VALUES (${wake.kind}, ${JSON.stringify(wake)})`;
    }
    // With the observe delay, its last reply (sent just before it resolved) comes in the same look.
    await this.schedule(OBSERVE_DELAY_SEC, "coordinatorTurn", "observe", { idempotent: true });
  }

  /**
   * The threads the inbox says finished, if still resolved, with their last word and the briefs and
   * notes in open threads that name them (by link or title), so a thread told to wait is not forgotten.
   */
  private finishedThreads(inbox: InboxItem[]): FinishedThread[] {
    const ids = [...new Set(inbox.flatMap((i) => (i.kind === "finished" ? [i.threadId] : [])))];
    const done = ids.map((id) => this.getThread(id)).filter((t): t is Thread => !!t?.resolved && !t.closeReason);
    if (done.length === 0) return [];
    const open = new Set(this.listThreads().filter((t) => !t.resolved).map((t) => t.id));
    const notes = this.sql<MessageRow>`
      SELECT * FROM (SELECT * FROM messages WHERE relay IS NOT NULL AND thread_id IS NOT NULL ORDER BY seq DESC LIMIT ${MENTION_SCAN})
      ORDER BY seq`
      .map((r) => this.toMessage(r))
      .filter((m) => m.relay && open.has(m.threadId!));
    return done.map((thread) => {
      const [last] = this.sql<MessageRow>`
        SELECT * FROM messages WHERE thread_id = ${thread.id} AND author_kind != 'user' AND body != ''
        ORDER BY seq DESC LIMIT 10`
        .map((r) => this.toMessage(r))
        .filter((m) => !isPlanMessage(m.body) && !m.relay);
      const named = (m: Message) =>
        m.relay!.fromThreadId === thread.id || m.relay!.note.includes(`#${thread.id})`) || m.relay!.note.includes(thread.title);
      const mentions = notes
        .filter((m) => m.threadId !== thread.id && named(m))
        .slice(-MENTION_LIMIT)
        .map((m) => ({ threadId: m.threadId!, note: m.relay!.note, createdAt: m.createdAt }));
      return { thread, last: last ?? null, mentions };
    });
  }

  // ---- Standing goal ----------------------------------------------------

  /** The standing goal, if one is set; it may be past its end until its last turn closes it. Callable over RPC. */
  getGoal(): Goal | null {
    const [r] = this.sql<GoalRow>`SELECT * FROM coordinator_goal WHERE id = 1`;
    return r
      ? { text: r.text, until: r.until_at, createdBy: r.created_by, createdAt: r.created_at, wakes: r.wakes, threads: r.threads, idle: r.idle }
      : null;
  }

  /** The standing goal while it still runs: set and not past its end. */
  private openGoal(): Goal | null {
    const goal = this.getGoal();
    return goal && Date.parse(goal.until) > Date.now() ? goal : null;
  }

  /** Tells clients the goal changed: set, moved along or ended. */
  private goalChanged() {
    this.emit({ type: "goal.updated", goal: this.getGoal() });
  }

  private endGoal(notice?: string) {
    this.sql`DELETE FROM coordinator_goal WHERE id = 1`;
    this.goalChanged();
    if (notice) this.sendMessage({ threadId: null, authorKind: "system", authorId: SYSTEM_ID, body: notice });
  }

  private goalHost(post: (body: string) => Message): GoalHost {
    return {
      setGoal: async ({ messageId, text, until, line }) => {
        const asked = this.getMessage(messageId);
        if (!asked || asked.threadId || asked.authorKind !== "user") {
          throw new Error(`${messageId} is not a person's project-chat message; set a goal only on a person's ask.`);
        }
        const createdAt = new Date().toISOString();
        this.sql`INSERT OR REPLACE INTO coordinator_goal (id, text, until_at, created_by, created_at, wakes, threads, idle)
          VALUES (1, ${text}, ${until.toISOString()}, ${asked.authorId}, ${createdAt}, 0, 0, 0)`;
        this.goalChanged();
        post(line);
        // A look at its end time, and every half hour in case a wake was missed; a replaced goal's checks find nothing to do.
        await this.schedule(until, "goalCheck", { createdAt, repeat: false }, { idempotent: false });
        await this.schedule(GOAL_CHECK_SEC, "goalCheck", { createdAt, repeat: true }, { idempotent: false });
        return this.getGoal()!;
      },
      finishGoal: async (summary) => {
        if (!this.getGoal()) throw new Error("No goal is open.");
        this.endGoal();
        post(summary);
      },
      defaultTimezone: this.defaultTimezone(),
    };
  }

  /** Schedule callback: the goal's end time came, or its fallback look while no thread is open. */
  async goalCheck(payload: { createdAt: string; repeat: boolean }): Promise<void> {
    const goal = this.getGoal();
    if (!goal || goal.createdAt !== payload.createdAt) return;
    if (Date.parse(goal.until) <= Date.now()) {
      await this.notifyCoordinator({ kind: "goal", reason: "end" });
      return;
    }
    if (!payload.repeat) return;
    if (!this.listThreads().some((t) => !t.resolved)) await this.notifyCoordinator({ kind: "goal", reason: "idle" });
    await this.schedule(GOAL_CHECK_SEC, "goalCheck", payload, { idempotent: false });
  }

  /**
   * Counts an automatic goal wake before its turn: how the coordinator is to treat it, "end" once the
   * goal ran out of time or wakes. Null when the turn was not a goal wake or the goal is gone.
   */
  private takeGoalWake(inbox: InboxItem[]): "idle" | "end" | null {
    const wakes = inbox.flatMap((i) => (i.kind === "goal" ? [i.reason] : []));
    const goal = this.getGoal();
    if (wakes.length === 0 || !goal) return null;
    this.sql`UPDATE coordinator_goal SET wakes = wakes + 1 WHERE id = 1`;
    this.goalChanged();
    const over = wakes.includes("end") || Date.parse(goal.until) <= Date.now() || goal.wakes + 1 >= GOAL_MAX_WAKES;
    return over ? "end" : "idle";
  }

  /** After a goal wake: a goal its last turn left open past its end is closed; idle wakes in a row end it too. */
  private settleGoal(wake: "idle" | "end" | null) {
    const goal = this.getGoal();
    if (!wake || !goal) return;
    if (wake === "end") {
      this.endGoal("The standing goal ended: its time or its limit of automatic turns ran out. Write in the chat to carry on.");
      return;
    }
    if (this.coordinatorWork > 0) {
      this.sql`UPDATE coordinator_goal SET idle = 0 WHERE id = 1`;
      this.goalChanged();
      return;
    }
    if (goal.idle + 1 >= GOAL_MAX_IDLE) {
      this.endGoal("The standing goal ended: the coordinator found no further work for it. Write in the chat to carry on.");
      return;
    }
    this.sql`UPDATE coordinator_goal SET idle = idle + 1 WHERE id = 1`;
    this.goalChanged();
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
    const rows = this.sql<InboxRow>`SELECT * FROM coordinator_inbox WHERE id > ${this.coordinatorTaken} ORDER BY id`;
    if (rows.length === 0) return; // an earlier turn already took these
    const first = rows[0]!.id;
    const last = rows.at(-1)!.id;
    this.coordinatorTaken = last;
    const inbox = rows.map((r) => JSON.parse(r.payload) as InboxItem);
    const questions: TurnQuestions = {
      open: new Map(inbox.flatMap((i) => (i.kind === "question" ? [[i.questionId, { threadId: i.threadId }] as const] : []))),
      settled: new Set(),
    };
    // The rows stay until the turn is over: deleting them first lost a person's message whenever
    // the turn threw or the object restarted, since the queue's retry then found an empty inbox.
    try {
      await this.runCoordinatorTurn(inbox, questions);
    } catch (err) {
      if (this.coordinatorTaken === last) this.coordinatorTaken = first - 1;
      throw err;
    }
    // A question the turn left alone (the model skipped it, its call failed, or the coordinator could
    // not run at all) goes to the person rather than waiting for the timeout.
    for (const [id, { threadId }] of questions.open) {
      if (questions.settled.has(id)) continue;
      const agent = await getAgentByName(this.env.THREAD_AGENT, threadId);
      await agent.escalateQuestion(id).catch((err) => console.error("passing a question on failed", err));
    }
    this.sql`DELETE FROM coordinator_inbox WHERE id BETWEEN ${first} AND ${last}`;
  }

  private async runCoordinatorTurn(inbox: InboxItem[], questions: TurnQuestions): Promise<void> {
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

    const goalWake = this.takeGoalWake(inbox);
    this.coordinatorWork = 0;
    this.setActivity(null, true);
    try {
      const { projectName, names } = await this.directory();
      const chat = this.sql<MessageRow>`
        SELECT * FROM (SELECT * FROM messages WHERE thread_id IS NULL ORDER BY seq DESC LIMIT ${COORDINATOR_HISTORY})
        ORDER BY seq`.map((r) => this.toMessage(r));
      const meter = new TurnMeter(llm.provider.model);
      const reacted = new Set<string>();
      const threadUpdates = inbox.flatMap((item) => {
        if (item.kind !== "thread") return [];
        const thread = this.getThread(item.threadId);
        const message = this.getMessage(item.messageId);
        return thread && message ? [{ thread, message }] : [];
      });
      const onlyThreadUpdates = onlyObserving(inbox);
      // Picking among the CLIs an ask offers goes by how much of their limits the computer reports used.
      const fresh = new Set(inbox.flatMap((i) => (i.kind === "message" ? [i.messageId] : [])));
      const choosing = chat.some((m) => fresh.has(m.id) && (m.clis?.length ?? 0) > 1);
      const computerClis = choosing ? ((await workspaceClis(this.env, this.name))?.clis ?? []) : undefined;
      // The offer a thread on the coordinator's own post inherits: the newest new ask's.
      const askClis = chat.filter((m) => fresh.has(m.id) && m.authorKind === "user" && (m.clis?.length ?? 0) > 0).at(-1)?.clis ?? [];
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
          goal: this.getGoal(),
          goalWake,
          inbox,
          threadUpdates,
          finished: this.finishedThreads(inbox),
          relays: this.recentRelays(),
          knowledge: this.knowledge.snapshot(),
          now: new Date(),
          defaultTimezone: this.defaultTimezone(),
          computerClis,
        }),
        tools: [
          ...coordinatorTools(this.coordinatorHost(meter, this.followUpFor(inbox), questions, reacted, this.startedFor(inbox), askClis), this.knowledgeHost({ kind: "agent", id: COORDINATOR_ID }), {
            onlyThreadUpdates,
          }),
          ...(onlyThreadUpdates ? [] : routineTools(this.routineHost(null))),
          ...(onlyThreadUpdates ? [] : goalTools(this.goalHost((body) => this.coordinatorPost(body, meter)))),
        ],
        maxSteps: 8,
        // One key per project: its turns share the system prompt, tools and most of the prompt.
        cacheKey: this.name,
      });
      // People always see that an edit was seen, even when the model skipped the reaction.
      for (const item of inbox) {
        if (item.kind === "edited" && !reacted.has(item.messageId) && this.getMessage(item.messageId)) {
          this.addReaction({ messageId: item.messageId, emoji: SEEN_EMOJI, authorKind: "agent", authorId: COORDINATOR_ID });
          reacted.add(item.messageId);
        }
      }
    } catch (err) {
      this.ctx.waitUntil(reportError(this.env, "agent", "coordinator turn", err));
      this.sendMessage({
        threadId: null,
        authorKind: "system",
        authorId: SYSTEM_ID,
        body: `The coordinator could not answer: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      this.settleGoal(goalWake);
      this.setActivity(null, false);
    }
  }

  /** The person whose message this coordinator turn answers, for usage attribution. */
  private turnRequester(inbox: InboxItem[]): string | null {
    for (const item of inbox) {
      const m = item.kind === "message" || item.kind === "edited" ? this.getMessage(item.messageId) : null;
      if (m?.authorKind === "user") return m.authorId;
    }
    // A goal wake works for the person who set the goal.
    if (inbox.some((i) => i.kind === "goal")) return this.getGoal()?.createdBy ?? null;
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
      if (item.kind === "message" || item.kind === "edited") {
        const m = this.getMessage(item.messageId);
        if (m?.authorKind === "user") people.add(m.authorId);
      } else if (item.kind === "routine") {
        const routine = this.getRoutine(item.routineId);
        people.add(routine && routine.createdBy !== "agent" ? routine.createdBy : "");
      } else if (item.kind === "goal") {
        people.add(this.getGoal()?.createdBy ?? "");
      }
    }
    const [only] = people;
    return people.size === 1 && only ? only : null;
  }

  /**
   * Who a follow-up this turn forwards to a thread is for, as forwardedFor. Undefined when no person
   * or routine asked anything this turn (the coordinator passes on what another thread reported or
   * decided): the note is then not someone's ask, and the thread keeps working for the person it
   * already works for, on their computer and with its CLI, rather than for nobody in the cloud.
   */
  private followUpFor(inbox: InboxItem[]): string | null | undefined {
    const asked = inbox.some((item) => {
      if (item.kind === "routine" || item.kind === "goal") return true;
      if (item.kind !== "message" && item.kind !== "edited") return false;
      return this.getMessage(item.messageId)?.authorKind === "user";
    });
    return asked ? this.forwardedFor(inbox) : undefined;
  }

  /**
   * Who a thread this coordinator turn opens on its own message works for: as forwardedFor, but a
   * thread's request counts for the person that thread works for. So a thread the coordinator opens
   * because another thread reported something runs where that one did (their computer), not in the
   * cloud as a thread nobody asked for. A thread opened on a person's message works for its author.
   */
  private startedFor(inbox: InboxItem[]): string | null {
    const requests = inbox.filter((i) => i.kind === "request");
    if (requests.length === 0) return this.forwardedFor(inbox);
    const asked = inbox.filter((i) => i.kind === "message" || i.kind === "edited" || i.kind === "routine" || i.kind === "goal");
    const people = new Set(requests.map((r) => r.actor ?? ""));
    if (asked.length > 0) people.add(this.forwardedFor(asked) ?? "");
    const [only] = people;
    return people.size === 1 && only ? only : null;
  }

  /** A coordinator message in the project chat, carrying the turn's usage so far. */
  private coordinatorPost(body: string, meter?: TurnMeter, relay?: MessageRelay): Message {
    return this.sendMessage({
      threadId: null,
      authorKind: "agent",
      authorId: COORDINATOR_ID,
      body,
      ...(relay && { relay }),
      ...(meter && { stats: meter.take() ?? undefined }),
    });
  }

  private coordinatorHost(
    meter?: TurnMeter,
    /** Who a follow-up this turn forwards is for (see followUpFor); undefined when nobody asked for it. */
    forwardedFor?: string | null,
    questions: TurnQuestions = { open: new Map(), settled: new Set() },
    /** Collects the messages the coordinator reacted to this turn. */
    reacted?: Set<string>,
    startedFor: string | null = null,
    /** The CLIs the turn's new ask offered, for threads split off it onto the coordinator's own posts. */
    askClis: string[] = [],
  ): CoordinatorHost {
    // The posts made this turn: a thread on one of them splits off the ask this turn routes.
    const posted = new Set<string>();
    const post = (body: string, relay?: MessageRelay) => {
      const m = this.coordinatorPost(body, meter, relay);
      posted.add(m.id);
      return m;
    };
    // The line in the thread where a note arrived, so people can open what the coordinator said.
    const relayInThread = (relay: MessageRelay, body: string) =>
      this.sendMessage({ threadId: relay.threadId, authorKind: "agent", authorId: COORDINATOR_ID, body, relay });
    // A question is settled once per turn, whichever way; the thread agent knows if it already went to people.
    const openQuestion = async (questionId: string) => {
      const q = questions.open.get(questionId);
      if (!q) throw new Error(`No question ${questionId} in this turn.`);
      if (questions.settled.has(questionId)) throw new Error(`Question ${questionId} is already handled.`);
      questions.settled.add(questionId);
      return { threadId: q.threadId, agent: await getAgentByName(this.env.THREAD_AGENT, q.threadId) };
    };
    return {
      getMessage: (id) => this.getMessage(id),
      offeredClis: (root) => offeredFor(root, posted, askClis),
      getThread: (id) => this.getThread(id),
      threadForRoot: (messageId) => this.listThreads().find((t) => t.rootMessageId === messageId) ?? null,
      post,
      react: (messageId, emoji) => {
        reacted?.add(messageId);
        this.addReaction({ messageId, emoji, authorKind: "agent", authorId: COORDINATOR_ID });
      },
      startThread: async ({ rootMessageId, title, brief, ack, projectAck, cli, runner }) => {
        const goal = this.openGoal();
        if (goal && (goal.threads >= GOAL_MAX_THREADS || goal.wakes >= GOAL_MAX_WAKES)) {
          throw new Error("The standing goal reached its limit. Start no more threads for it; call finish_goal with a summary for the person.");
        }
        if (goal) {
          this.sql`UPDATE coordinator_goal SET threads = threads + 1 WHERE id = 1`;
          this.goalChanged();
        }
        this.coordinatorWork++;
        // The id comes first so the "on it" line can carry the brief before the thread exists.
        const relay: MessageRelay = { kind: "brief", threadId: createId("thread"), note: brief };
        // The project-chat line goes first so the card can sit under it: ask, "on it", card.
        const ackMessage = projectAck ? post(projectAck, relay) : null;
        const thread = this.createThread(rootMessageId, title, ackMessage?.id ?? null, relay.threadId, cli ?? null, runner ?? null);
        relayInThread(relay, ack || relayLine("brief", brief));
        const agent = await getAgentByName(this.env.THREAD_AGENT, thread.id);
        await agent.start({ projectId: this.name, threadId: thread.id, brief, actor: startedFor });
        return thread;
      },
      findDuplicate: (messageId) => this.findDuplicateThread(messageId),
      closeThread: (threadId, input) => this.closeThread(threadId, { ...input, by: "coordinator" }),
      messageThread: async (threadId, note, kind, interrupt) => {
        const thread = this.getThread(threadId);
        this.coordinatorWork++;
        // Reopened right away, so the card stops reading "Resolved" before the thread's turn starts.
        const reopened = !!thread?.resolved;
        if (reopened) this.updateThread(threadId, { resolved: false, status: "working" });
        relayInThread({ kind, threadId, note }, relayLine(kind, note));
        // A forwarded ask works for whoever asked it; an answer to the thread's own request changes nothing.
        const wake = { kind: "coordinator", note, reopened, ...(kind === "follow_up" && forwardedFor !== undefined && { forwardedFor }) } as const;
        if (interrupt) return (await getAgentByName(this.env.THREAD_AGENT, threadId)).coordinatorInterrupt(wake);
        await this.wakeThread(threadId, wake);
      },
      answerQuestion: async (questionId, answer, source) => {
        const { threadId, agent } = await openQuestion(questionId);
        const taken = await agent.answeredQuestion(questionId);
        if (!taken) throw new Error("That question already went to the person (it waited too long). Leave it.");
        const line = answerLine(answer, source, taken.question);
        relayInThread({ kind: "answer", threadId, note: `${taken.question}\n\n→ **${answer}** · ${source}` }, line);
        await this.wakeThread(threadId, {
          kind: "coordinator",
          note: `The coordinator answered your question "${taken.question}" from what the project already settles: ${answer} (source: ${source}). Carry on with it; people see the answer in the thread and can still change it there.`,
        });
      },
      askPerson: async (questionId, note) => {
        const { agent } = await openQuestion(questionId);
        if (!(await agent.escalateQuestion(questionId, note))) throw new Error("That question already went to the person.");
      },
      relay: async (fromThreadId, toThreadId, note, interrupt) => {
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
        // Telling a thread that the work it waits on is finished is new, even right after the last note.
        const [lastNote] = this.sql<{ at: string }>`SELECT MAX(created_at) AS at FROM coordinator_relays
          WHERE (from_thread_id = ${from.id} AND to_thread_id = ${to.id}) OR (from_thread_id = ${to.id} AND to_thread_id = ${from.id})`;
        const finishedSince = from.resolved && !!lastNote?.at && from.updatedAt > lastNote.at;
        if (recent!.n > 0 && !finishedSince) {
          throw new Error(`You already relayed between "${from.title}" and "${to.title}" in the last few minutes; do not relay again.`);
        }
        this.sql`INSERT INTO coordinator_relays (from_thread_id, to_thread_id, note, created_at)
          VALUES (${from.id}, ${to.id}, ${note}, ${new Date().toISOString()})`;
        relayInThread({ kind: "relay", threadId: to.id, fromThreadId: from.id, note }, relayLine("relay", note, from.title));
        const wake = { kind: "coordinator", note: `From the "${from.title}" thread: ${note}` } as const;
        if (interrupt) return (await getAgentByName(this.env.THREAD_AGENT, to.id)).coordinatorInterrupt(wake);
        await this.wakeThread(to.id, wake);
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

  markMemory(name: string, input: MarkMemoryInput) {
    return this.knowledge.markMemory(name, input);
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

  // ---- Memory upkeep -----------------------------------------------------
  // After enough threads finish, a thread checks the notes against the project (memory-upkeep.ts).

  private upkeepMode(): MemoryUpkeepMode {
    return MemoryUpkeepMode.catch("auto").parse(this.knowledge.getSetting(UPKEEP_KEYS.mode));
  }

  /** The upkeep thread, while it is still open. */
  private openUpkeepThread(): Thread | null {
    const id = this.knowledge.getSetting(UPKEEP_KEYS.threadId);
    const thread = id ? this.getThread(id) : null;
    return thread && !thread.resolved ? thread : null;
  }

  /** Tasks run on a local folder's CLI (not forced to the cloud): upkeep then costs no plan usage. */
  private async runsLocally(): Promise<boolean> {
    const [row] = await createDb(this.env.DB)
      .select({ taskTarget: schema.projects.taskTarget })
      .from(schema.projects)
      .where(eq(schema.projects.id, this.name));
    if (row?.taskTarget === "cloud") return false;
    return !!(await workspaceClis(this.env, this.name));
  }

  async memoryUpkeep(): Promise<MemoryUpkeepState> {
    const mode = this.upkeepMode();
    return {
      mode,
      active: upkeepActive(mode, await this.runsLocally()),
      lastRunAt: this.knowledge.getSetting(UPKEEP_KEYS.lastRunAt),
      threadsSince: Number(this.knowledge.getSetting(UPKEEP_KEYS.threadsSince) ?? 0),
      threadsNeeded: UPKEEP_THREADS,
      threadId: this.openUpkeepThread()?.id ?? null,
    };
  }

  async setMemoryUpkeepMode(mode: MemoryUpkeepMode): Promise<MemoryUpkeepState> {
    this.knowledge.setSetting(UPKEEP_KEYS.mode, mode);
    this.emit({ type: "knowledge.changed", kind: "memory" });
    return this.memoryUpkeep();
  }

  /** A thread finished: count it, and start upkeep once it is due. The upkeep thread itself does not count. */
  private async countForUpkeep(threadId: string) {
    if (threadId === this.knowledge.getSetting(UPKEEP_KEYS.threadId)) return;
    const threadsSince = Number(this.knowledge.getSetting(UPKEEP_KEYS.threadsSince) ?? 0) + 1;
    this.knowledge.setSetting(UPKEEP_KEYS.threadsSince, String(threadsSince));
    const lastRunAt = this.knowledge.getSetting(UPKEEP_KEYS.lastRunAt);
    if (!upkeepDue({ threadsSince, lastRunAt, now: new Date() })) return;
    if (this.openUpkeepThread() || !this.hasNotes()) return;
    if (!upkeepActive(this.upkeepMode(), await this.runsLocally())) return;
    // A local folder's owner runs it on their own CLI; otherwise it works for the project's owner.
    const actor = (await workspaceClis(this.env, this.name))?.ownerId ?? (await this.projectOwner());
    await this.startUpkeep(actor, false);
  }

  /** "Check now" from the Memory tab: works for whoever asked. */
  async runMemoryUpkeep(userId: string): Promise<{ thread: Thread } | { error: "running" | "no_notes" }> {
    const open = this.openUpkeepThread();
    if (open) return { error: "running" };
    if (!this.hasNotes()) return { error: "no_notes" };
    return { thread: await this.startUpkeep(userId, true) };
  }

  private hasNotes(): boolean {
    return this.knowledge.listMemory().some((m) => m.name !== MEMORY_INDEX);
  }

  private async projectOwner(): Promise<string | null> {
    const [row] = await createDb(this.env.DB)
      .select({ userId: schema.projectMembers.userId })
      .from(schema.projectMembers)
      .where(and(eq(schema.projectMembers.projectId, this.name), eq(schema.projectMembers.role, "owner")))
      .limit(1);
    return row?.userId ?? null;
  }

  /** Opens the upkeep thread under a project-chat line, the way the coordinator opens one for an ask. */
  private async startUpkeep(actor: string | null, manual: boolean): Promise<Thread> {
    const threadsSince = Number(this.knowledge.getSetting(UPKEEP_KEYS.threadsSince) ?? 0);
    const notes = this.knowledge.listMemory().filter((m) => m.name !== MEMORY_INDEX).length;
    const root = this.sendMessage({ threadId: null, authorKind: "system", authorId: MEMORY_UPKEEP_ID, body: upkeepNotice(threadsSince, manual) });
    const brief = upkeepBrief(notes);
    const thread = this.createThread(root.id, UPKEEP_TITLE);
    this.knowledge.setSetting(UPKEEP_KEYS.threadId, thread.id);
    this.knowledge.setSetting(UPKEEP_KEYS.lastRunAt, new Date().toISOString());
    this.knowledge.setSetting(UPKEEP_KEYS.threadsSince, "0");
    const relay: MessageRelay = { kind: "brief", threadId: thread.id, note: brief };
    this.sendMessage({ threadId: thread.id, authorKind: "agent", authorId: COORDINATOR_ID, body: relayLine("brief", brief), relay });
    const agent = await getAgentByName(this.env.THREAD_AGENT, thread.id);
    await agent.start({ projectId: this.name, threadId: thread.id, brief, actor });
    this.emit({ type: "knowledge.changed", kind: "memory" });
    return thread;
  }

  private knowledgeHost(by: Author): KnowledgeHost {
    return {
      memoryRead: (name) => this.getMemory(name),
      memoryWrite: (name, description, content) => this.putMemory(name, { description, content }, by),
      memoryMark: (name, input) => this.markMemory(name, input),
      memoryDelete: (name) => this.deleteMemory(name),
      memoryNames: () => this.listMemory().map((m) => m.name),
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
      ...(r.edited_at && { editedAt: r.edited_at }),
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
      runner: r.runner ? (JSON.parse(r.runner) as ThreadRunner) : null,
      model: r.model ? (JSON.parse(r.model) as ThreadModel) : null,
      seenSeq: r.seen_seq ?? null,
      summary: this.threadSummary(r.id),
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

/**
 * When a routine runs next: the next cron match, or a one-off time that has not run yet and is still
 * ahead (one whose time passed while it was paused is finished, not fired late on resume or edit).
 */
function nextRun(schedule: RoutineSchedule, lastRunAt: string | null): Date | null {
  if (schedule.kind === "cron") return nextCronRun(schedule.cron, schedule.timezone, new Date());
  const at = new Date(schedule.at);
  if (at.getTime() <= Date.now()) return null;
  return lastRunAt && Date.parse(lastRunAt) >= at.getTime() - 1000 ? null : at;
}

/** Why a thread agent is woken. */
/** reopened: the thread was resolved and this wake opens it again, so its work starts a new round with its own plan card. */
export type ThreadWake =
  /** body, authorId, seq: a person's message, which may answer a question the running turn waits on. */
  /** edited: a person changed an earlier message's text; it shows as new in the agent's next turn. */
  | { kind: "message"; messageId: string; body?: string; authorId?: string; seq?: number; reopened?: boolean; edited?: boolean }
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
