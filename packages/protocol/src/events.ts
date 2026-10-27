import { z } from "zod";
import { KnowledgeKind, MAX_ATTACHMENTS } from "./knowledge";
import { FilePath } from "./paths";
import { Artifact } from "./artifacts";
import { Routine, RoutineId } from "./routines";
import { Goal } from "./goal";
import { CliId, RunnerId } from "./runner";
import { CLOUD_RUNNER, MAX_MESSAGE_LENGTH, MAX_THREAD_CLIS, Message, PullRequest, Reaction, Task, TaskId, TerminalLine, Thread, ThreadCloseReason, ThreadId } from "./models";

export const SYNC_PAGE_SIZE = 200;

/** How much of one conversation (the project chat, or a thread) a client holds, from its newest message. */
export const ConversationWindow = z.object({
  /** null: the project chat. */
  threadId: ThreadId.nullable(),
  /** Older messages are left on the server (GET /projects/:id/messages?thread&before). */
  hasEarlier: z.boolean(),
});
export type ConversationWindow = z.infer<typeof ConversationWindow>;

/** Messages a conversation page holds, newest page first: `GET /projects/:id/messages?thread=…&before=…`. */
export const CONVERSATION_PAGE_SIZE = 60;

/** One page of a conversation, oldest first, ending just before the `before` seq asked for (or at the newest). */
export type ConversationPage = {
  messages: Message[];
  hasEarlier: boolean;
  reactions: Reaction[];
  /** A thread's first page (its oldest): the project-chat message it opened from, if asked for one. */
  root?: Message;
};

/** Events the client sends over the project WebSocket. */
export const ClientEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message.send"),
    /** Client-chosen id echoed back in `message.ack`, for optimistic UI. */
    clientId: z.string().max(64).optional(),
    threadId: ThreadId.nullable().default(null),
    /** May be empty when the message carries attachments. */
    body: z.string().trim().max(MAX_MESSAGE_LENGTH),
    /** Paths of files already uploaded to the project files (see POST /uploads). */
    attachments: z.array(FilePath).max(MAX_ATTACHMENTS).default([]),
    /**
     * A new ask in the project chat: the CLIs on the sender's computer its thread may run with (see
     * Message.clis). Ignored in a thread and for anyone but the computer's owner.
     */
    clis: z.array(CliId).max(MAX_THREAD_CLIS).optional(),
  }).refine((e) => e.body.length > 0 || e.attachments.length > 0, "Write something or attach a file"),
  /**
   * A person changes the text of their own message. Attachments stay; the text may be empty only when
   * the message has some. Comes back as `message.updated` with editedAt set.
   */
  z.object({
    type: z.literal("message.edit"),
    messageId: Message.shape.id,
    body: z.string().trim().max(MAX_MESSAGE_LENGTH),
  }),
  /** A person marks a thread resolved (optionally closing it with a reason), or reopens it. */
  z.object({
    type: z.literal("thread.resolve"),
    threadId: ThreadId,
    resolved: z.boolean(),
    reason: ThreadCloseReason.optional(),
  }),
  /** The computer's owner picks the CLI a thread runs with from now on; null: the project folder's again. */
  z.object({
    type: z.literal("thread.cli"),
    threadId: ThreadId,
    cli: CliId.nullable(),
  }),
  /**
   * The owner of one of the project's computers sets a thread to work there from its next turn, or
   * any member sets it to the cloud (CLOUD_RUNNER); null: the project's default computer again.
   */
  z.object({
    type: z.literal("thread.runner"),
    threadId: ThreadId,
    runnerId: z.union([RunnerId, z.literal(CLOUD_RUNNER)]).nullable(),
  }),
  /**
   * Someone who can pick the thread's CLI picks its model and effort for that CLI; null for both:
   * the project's defaults again.
   */
  z.object({
    type: z.literal("thread.model"),
    threadId: ThreadId,
    cli: CliId,
    model: z.string().trim().min(1).max(200).nullable(),
    effort: z.string().trim().min(1).max(20).nullable(),
  }),
  /** Any member ends the project's standing goal; the coordinator stops waking by itself for it. */
  z.object({ type: z.literal("goal.stop") }),
  z.object({
    type: z.literal("sync"),
    /** Return messages with seq strictly greater than this. 0 = from the start. */
    afterSeq: z.number().int().nonnegative(),
    /**
     * Send every page back to back instead of one page per request, so a long
     * history arrives without a round trip per page. The last page has hasMore false.
     */
    all: z.boolean().optional(),
    /**
     * Send only the newest this many messages of the project chat (with the messages thread cards
     * hang under) instead of the whole history; threads are loaded when opened (`ConversationPage`).
     * Also used after a long time away, when catching up would mean too many messages.
     */
    recent: z.number().int().positive().max(SYNC_PAGE_SIZE).optional(),
  }),
]);
export type ClientEvent = z.infer<typeof ClientEvent>;
export type ClientEventInput = z.input<typeof ClientEvent>;

/** Events the server sends over the project WebSocket. */
export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.created"), message: Message }),
  /** A message's body changed in place (an agent's plan card moving along, a person's edit). Keeps its seq. */
  z.object({ type: z.literal("message.updated"), message: Message }),
  z.object({
    type: z.literal("message.ack"),
    clientId: z.string(),
    messageId: Message.shape.id,
    seq: Message.shape.seq,
  }),
  z.object({
    type: z.literal("sync.result"),
    messages: z.array(Message),
    /** True when more messages remain after the last one returned. */
    hasMore: z.boolean(),
    /** The server sends the next page by itself (the sync asked for `all`); don't ask for it. */
    streamed: z.boolean().optional(),
    /** Every thread in the project, current state (threads are few and change in place). */
    threads: z.array(Thread).default([]),
    /** Reactions on the returned messages. */
    reactions: z.array(Reaction).default([]),
    /** Every artifact in the project, current state. */
    artifacts: z.array(Artifact).default([]),
    /** Every routine in the project, current state. */
    routines: z.array(Routine).default([]),
    /** The project's standing goal, null when none is open (absent from older servers). */
    goal: Goal.nullable().optional(),
    /**
     * Set when the sync answered `recent` with only the newest messages: the conversations it holds
     * from their newest message, each saying whether older ones are left on the server.
     */
    windows: z.array(ConversationWindow).optional(),
    /** The client should drop the messages it holds first: they are too far behind to catch up. */
    reset: z.boolean().optional(),
    /** The project's newest seq: the client is caught up to it even when the messages it holds stop earlier. */
    lastSeq: z.number().int().nonnegative().optional(),
  }),
  /** A thread was created or changed (title, status, checklist, resolved). */
  z.object({ type: z.literal("thread.updated"), thread: Thread }),
  z.object({ type: z.literal("reaction.added"), reaction: Reaction }),
  /** An artifact was published or got a new version. */
  z.object({ type: z.literal("artifact.updated"), artifact: Artifact }),
  /** A routine was created or changed (schedule, paused, a run happened). */
  z.object({ type: z.literal("routine.updated"), routine: Routine }),
  z.object({ type: z.literal("routine.deleted"), routineId: RoutineId }),
  /** The standing goal was set, moved along (wakes, threads) or ended (null). */
  z.object({ type: z.literal("goal.updated"), goal: Goal.nullable() }),
  /**
   * An agent started or stopped working. threadId null = the coordinator in the project chat.
   * Ephemeral: not replayed by sync.
   */
  z.object({
    type: z.literal("agent.activity"),
    threadId: ThreadId.nullable(),
    active: z.boolean(),
    /** What the agent is doing, e.g. a local task's latest step. */
    label: z.string().max(200).optional(),
  }),
  /** Project files, memory or instructions changed; clients refetch that list. */
  z.object({ type: z.literal("knowledge.changed"), kind: KnowledgeKind }),
  /** The project's local folder changed, or its computer came online or went offline. */
  z.object({ type: z.literal("workspace.changed") }),
  /** A task started, finished or changed. */
  z.object({ type: z.literal("task.updated"), task: Task }),
  /** New terminal output from a running task. Ephemeral: earlier output comes from the tasks endpoint. */
  z.object({ type: z.literal("task.output"), taskId: TaskId, threadId: ThreadId, lines: z.array(TerminalLine) }),
  /** A pull request a thread opened changed on GitHub (CI, review, merge). */
  z.object({ type: z.literal("pr.updated"), pullRequest: PullRequest }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

