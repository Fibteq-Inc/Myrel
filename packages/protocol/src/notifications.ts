import { z } from "zod";
import { idPattern } from "./ids";
import { ProjectId, ThreadId, Timestamp } from "./models";

export const NotificationId = z.string().regex(idPattern("notification"));

/**
 * done: a thread was resolved. ready: a thread's agent replied and waits on a person.
 * decision: it needs someone to decide. blocked: it is stuck on something only a person can change.
 * failed: its turn errored.
 */
export const NotificationKind = z.enum(["done", "ready", "decision", "blocked", "failed"]);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const Notification = z.object({
  id: NotificationId,
  projectId: ProjectId,
  threadId: ThreadId.nullable(),
  kind: NotificationKind,
  /** Usually the thread title. */
  title: z.string(),
  /** A short excerpt of what happened, plain text. */
  body: z.string(),
  /** App path to open, e.g. /projects/proj_…/threads/thr_… */
  url: z.string(),
  readAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type Notification = z.infer<typeof Notification>;

/** Per-user delivery channels. The in-app list always receives everything. */
export const NotificationSettings = z.object({
  email: z.boolean(),
  push: z.boolean(),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

/** What the server can deliver, so apps only offer channels that work. */
export const NotificationConfig = z.object({
  /** VAPID public key for Web Push subscriptions; null when Web Push is not configured. */
  webPushKey: z.string().nullable(),
  email: z.boolean(),
});
export type NotificationConfig = z.infer<typeof NotificationConfig>;

/** A device registering for push: a browser (Web Push) or a native app (Expo push token). */
export const PushSubscriptionInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("webpush"),
    endpoint: z.url().max(2048),
    keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
  }),
  z.object({ kind: z.literal("expo"), token: z.string().min(1).max(256) }),
]);
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;

export const MarkNotificationsReadInput = z.union([
  z.object({ ids: z.array(NotificationId).min(1).max(200) }),
  z.object({ all: z.literal(true) }),
]);
export type MarkNotificationsReadInput = z.infer<typeof MarkNotificationsReadInput>;
