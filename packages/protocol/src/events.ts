import { z } from "zod";
import { KnowledgeKind, MAX_ATTACHMENTS } from "./knowledge";
import { FilePath } from "./paths";
import { Artifact } from "./artifacts";
import { Routine, RoutineId } from "./routines";
import { MAX_MESSAGE_LENGTH, Message, Reaction, Task, TaskId, TerminalLine, Thread, ThreadId } from "./models";

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
  }).refine((e) => e.body.length > 0 || e.attachments.length > 0, "Write something or attach a file"),
  /** A person marks a thread resolved, or reopens it. */
  z.object({ type: z.literal("thread.resolve"), threadId: ThreadId, resolved: z.boolean() }),
  z.object({
    type: z.literal("sync"),
    /** Return messages with seq strictly greater than this. 0 = from the start. */
    afterSeq: z.number().int().nonnegative(),
  }),
]);
export type ClientEvent = z.infer<typeof ClientEvent>;
export type ClientEventInput = z.input<typeof ClientEvent>;

/** Events the server sends over the project WebSocket. */
export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.created"), message: Message }),
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
    /** Every thread in the project, current state (threads are few and change in place). */
    threads: z.array(Thread).default([]),
    /** Reactions on the returned messages. */
    reactions: z.array(Reaction).default([]),
    /** Every artifact in the project, current state. */
    artifacts: z.array(Artifact).default([]),
    /** Every routine in the project, current state. */
    routines: z.array(Routine).default([]),
  }),
  /** A thread was created or changed (title, status, checklist, resolved). */
  z.object({ type: z.literal("thread.updated"), thread: Thread }),
  z.object({ type: z.literal("reaction.added"), reaction: Reaction }),
  /** An artifact was published or got a new version. */
  z.object({ type: z.literal("artifact.updated"), artifact: Artifact }),
  /** A routine was created or changed (schedule, paused, a run happened). */
  z.object({ type: z.literal("routine.updated"), routine: Routine }),
  z.object({ type: z.literal("routine.deleted"), routineId: RoutineId }),
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
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

export const SYNC_PAGE_SIZE = 200;
