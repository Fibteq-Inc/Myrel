import { createDb, schema } from "@myrel/db";
import {
  type Attachment,
  type Artifact,
  type ArtifactVersion,
  type AuthorKind,
  ClientEvent,
  type CreateRoutineInput,
  createId,
  type Message,
  type MessageStats,
  type ArtifactRef,
  nextCronRun,
  normalizeFilePath,
  planChecklist,
  type NotificationKind,
  type PullRequest,
  type Reaction,
  type Routine,
  type RoutineSchedule,
  type RoutineTarget,
  type ServerEvent,
  SYNC_PAGE_SIZE,
  type Thread,
  type ThreadStatus,
  type UpdateRoutineInput,
} from "@myrel/protocol";
import { Agent, type Connection, type ConnectionContext, getAgentByName } from "agents";
import { eq } from "drizzle-orm";
import { canUseCoordinator } from "../extensions";
import { projectProvider } from "../keys";
import { runLoop } from "../llm";
import { ArtifactError, ArtifactStore, type PublishInput } from "./artifact-store";
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
  label: string | null;
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
};

export type ThreadPatch = Partial<Pick<Thread, "title" | "status" | "statusText" | "resolved" | "label">>;

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
        const message = this.sendMessage({
          threadId: event.threadId,
          authorKind: "user",
          authorId: userId,
          body: event.body,
          attachments,
        });
        if (event.clientId) {
          send(connection, { type: "message.ack", clientId: event.clientId, messageId: message.id, seq: message.seq });
        }
        if (message.threadId) {
          // Writing in a finished thread picks it up again.
          if (this.getThread(message.threadId)?.resolved) {
            this.updateThread(message.threadId, { resolved: false, status: "working" });
          }
          await this.wakeThread(message.threadId, {
            kind: "message",
            messageId: message.id,
            body: message.body,
            authorId: userId,
            seq: message.seq,
          });
        }
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
      INSERT INTO messages (id, thread_id, author_kind, author_id, body, attachments, artifacts, stats, created_at)
      VALUES (${id}, ${input.threadId}, ${input.authorKind}, ${input.authorId}, ${input.body}, ${stored},
        ${artifacts ? JSON.stringify(artifacts) : null}, ${input.stats ? JSON.stringify(input.stats) : null}, ${createdAt})
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

  // ---- Threads -----------------------------------------------------------

  /** Opens a thread under a project-chat message. Callable over RPC. */
  createThread(rootMessageId: string, title: string, ackMessageId: string | null = null): Thread {
    const id = createId("thread");
    const now = new Date().toISOString();
    this.sql`INSERT INTO threads (id, root_message_id, ack_message_id, title, status, status_text, resolved, label, created_at, updated_at)
      VALUES (${id}, ${rootMessageId}, ${ackMessageId}, ${title}, ${"working"}, ${null}, 0, ${null}, ${now}, ${now})`;
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
    this.sql`UPDATE threads SET title = ${next.title}, status = ${next.status}, status_text = ${next.statusText},
      resolved = ${next.resolved ? 1 : 0}, label = ${next.label}, updated_at = ${next.updatedAt} WHERE id = ${id}`;
    this.emit({ type: "thread.updated", thread: next });
    this.syncActivity();
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

  /** Renames, reschedules, pauses or resumes a routine. Callable over RPC. */
  async updateRoutine(id: string, patch: UpdateRoutineInput): Promise<Routine | null> {
    const current = this.getRoutine(id);
    if (!current) return null;
    if (patch.schedule) this.checkSchedule(patch.schedule);
    const next = { ...current, ...patch };
    this.sql`UPDATE routines SET name = ${next.name}, prompt = ${next.prompt}, schedule = ${JSON.stringify(next.schedule)},
      paused = ${next.paused ? 1 : 0} WHERE id = ${id}`;
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
        if (thread.resolved) this.updateThread(thread.id, { resolved: false });
        await this.wakeThread(thread.id, { kind: "routine", name: routine.name, prompt: routine.prompt });
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
   * agent's replies, while another thread is open that it could matter to. Plan cards and
   * attachment-only messages carry nothing to relay.
   */
  private observable(m: Message): m is Message & { threadId: string } {
    if (!m.threadId || !m.body.trim() || planChecklist(m.body) !== null) return false;
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
        }),
        tools: [
          ...coordinatorTools(this.coordinatorHost(meter), this.knowledgeHost({ kind: "agent", id: COORDINATOR_ID }), {
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

  private coordinatorHost(meter?: TurnMeter): CoordinatorHost {
    const post = (body: string) =>
      this.sendMessage({
        threadId: null,
        authorKind: "agent",
        authorId: COORDINATOR_ID,
        body,
        ...(meter && { stats: meter.take() ?? undefined }),
      });
    return {
      getMessage: (id) => this.getMessage(id),
      getThread: (id) => this.getThread(id),
      threadForRoot: (messageId) => this.listThreads().find((t) => t.rootMessageId === messageId) ?? null,
      post,
      react: (messageId, emoji) => this.addReaction({ messageId, emoji, authorKind: "agent", authorId: COORDINATOR_ID }),
      startThread: async ({ rootMessageId, title, brief, ack, projectAck }) => {
        // The project-chat line goes first so the card can sit under it: ask, "on it", card.
        const ackMessage = projectAck ? post(projectAck) : null;
        const thread = this.createThread(rootMessageId, title, ackMessage?.id ?? null);
        if (ack) this.sendMessage({ threadId: thread.id, authorKind: "agent", authorId: COORDINATOR_ID, body: ack });
        const agent = await getAgentByName(this.env.THREAD_AGENT, thread.id);
        await agent.start({ projectId: this.name, threadId: thread.id, brief });
        return thread;
      },
      messageThread: async (threadId, note) => {
        const thread = this.getThread(threadId);
        // Reopened right away, so the card stops reading "Resolved" before the thread's turn starts.
        if (thread?.resolved) this.updateThread(threadId, { resolved: false, status: "working" });
        await this.wakeThread(threadId, { kind: "coordinator", note });
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

  private emit(event: ServerEvent) {
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
      label: r.label,
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

/** When a routine runs next: the next cron match, or a one-off time that has not run yet. */
function nextRun(schedule: RoutineSchedule, lastRunAt: string | null): Date | null {
  if (schedule.kind === "cron") return nextCronRun(schedule.cron, schedule.timezone, new Date());
  const at = new Date(schedule.at);
  return lastRunAt && Date.parse(lastRunAt) >= at.getTime() - 1000 ? null : at;
}

/** Why a thread agent is woken. */
export type ThreadWake =
  /** body, authorId, seq: a person's message, which may answer a question the running turn waits on. */
  | { kind: "message"; messageId: string; body?: string; authorId?: string; seq?: number }
  | { kind: "coordinator"; note: string }
  | { kind: "routine"; name: string; prompt: string }
  /**
   * Something happened on a pull request the thread opened (github/pulls.ts). settled: it was merged
   * or closed, which needs no turn of its own unless the thread's plan still has work.
   */
  | { kind: "github"; event: string; settled?: { pr: string; merged: boolean } };

function send(connection: Connection, event: ServerEvent) {
  connection.send(JSON.stringify(event));
}
