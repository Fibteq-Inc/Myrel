import { z } from "zod";
import { MAX_MESSAGE_LENGTH, Message, Reaction, Thread, ThreadId } from "./models";

/** Events the client sends over the project WebSocket. */
export const ClientEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message.send"),
    /** Client-chosen id echoed back in `message.ack`, for optimistic UI. */
    clientId: z.string().max(64).optional(),
    threadId: ThreadId.nullable().default(null),
    body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  }),
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
  }),
  /** A thread was created or changed (title, status, checklist, resolved). */
  z.object({ type: z.literal("thread.updated"), thread: Thread }),
  z.object({ type: z.literal("reaction.added"), reaction: Reaction }),
  /**
   * An agent started or stopped working. threadId null = the coordinator in the project chat.
   * Ephemeral: not replayed by sync.
   */
  z.object({ type: z.literal("agent.activity"), threadId: ThreadId.nullable(), active: z.boolean() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

export const SYNC_PAGE_SIZE = 200;
