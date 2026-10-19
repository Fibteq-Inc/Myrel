import { z } from "zod";
import { MAX_MESSAGE_LENGTH, Message, ThreadId } from "./models";

/** Events the client sends over the project WebSocket. */
export const ClientEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message.send"),
    /** Client-chosen id echoed back in `message.ack`, for optimistic UI. */
    clientId: z.string().max(64).optional(),
    threadId: ThreadId.nullable().default(null),
    body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  }),
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
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

export const SYNC_PAGE_SIZE = 200;
