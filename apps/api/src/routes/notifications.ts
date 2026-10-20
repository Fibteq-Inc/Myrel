import { createDb, schema } from "@myrel/db";
import {
  MarkNotificationsReadInput,
  type Notification,
  NotificationSettings,
  PushSubscriptionInput,
} from "@myrel/protocol";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, requireUser } from "../middleware";
import { notificationConfig } from "../notifications/channels";

const { notifications, notificationSettings, pushSubscriptions } = schema;

/** The signed-in user's notifications, delivery settings and push devices. */
export const notificationRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .get("/", async (c) => {
    const userId = c.get("user").id;
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const db = createDb(c.env.DB);
    const [rows, [unread]] = await Promise.all([
      db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt))
        .limit(limit),
      db
        .select({ n: count() })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt))),
    ]);
    return c.json({ notifications: rows.map(toNotification), unread: unread?.n ?? 0 });
  })
  .post("/read", async (c) => {
    const input = MarkNotificationsReadInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    const userId = c.get("user").id;
    const mine = and(eq(notifications.userId, userId), isNull(notifications.readAt));
    await createDb(c.env.DB)
      .update(notifications)
      .set({ readAt: new Date() })
      .where("ids" in input.data ? and(mine, inArray(notifications.id, input.data.ids)) : mine);
    return c.json({ ok: true });
  })
  .get("/config", (c) => c.json(notificationConfig(c.env)))
  .get("/settings", async (c) => c.json(await readSettings(c.env, c.get("user").id)))
  .put("/settings", async (c) => {
    const input = NotificationSettings.partial().safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    const userId = c.get("user").id;
    const next = { ...(await readSettings(c.env, userId)), ...input.data };
    await createDb(c.env.DB)
      .insert(notificationSettings)
      .values({ userId, ...next })
      .onConflictDoUpdate({ target: notificationSettings.userId, set: { ...next, updatedAt: new Date() } });
    return c.json(next);
  })
  .post("/subscriptions", async (c) => {
    const input = PushSubscriptionInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    const userId = c.get("user").id;
    const row =
      input.data.kind === "webpush"
        ? { kind: "webpush" as const, endpoint: input.data.endpoint, ...input.data.keys }
        : { kind: "expo" as const, endpoint: input.data.token, p256dh: null, auth: null };
    // A device belongs to whoever registered it last (shared browsers, re-logins).
    await createDb(c.env.DB)
      .insert(pushSubscriptions)
      .values({ id: crypto.randomUUID(), userId, ...row })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId, p256dh: row.p256dh, auth: row.auth } });
    return c.json({ ok: true }, 201);
  })
  .delete("/subscriptions", async (c) => {
    const input = z.object({ endpoint: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    await createDb(c.env.DB)
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, c.get("user").id), eq(pushSubscriptions.endpoint, input.data.endpoint)));
    return c.json({ ok: true });
  });

async function readSettings(env: Env, userId: string): Promise<NotificationSettings> {
  const [row] = await createDb(env.DB)
    .select({ email: notificationSettings.email, push: notificationSettings.push })
    .from(notificationSettings)
    .where(eq(notificationSettings.userId, userId));
  return row ?? { email: true, push: true };
}

function toNotification(r: typeof notifications.$inferSelect): Notification {
  return {
    id: r.id,
    projectId: r.projectId,
    threadId: r.threadId,
    kind: r.kind,
    title: r.title,
    body: r.body,
    url: r.url,
    readAt: r.readAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}
