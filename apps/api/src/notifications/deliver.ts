import { createDb, schema } from "@altair/db";
import { createId, type NotificationKind } from "@altair/protocol";
import { eq, inArray } from "drizzle-orm";
import { emailEnabled, sendEmail, sendExpoPush, vapidKeys } from "./channels";
import { sendWebPush } from "./webpush";

const { notifications, notificationSettings, projectMembers, pushSubscriptions, user } = schema;

export type NotifyInput = {
  projectId: string;
  projectName: string;
  threadId: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  /** App path, e.g. /projects/proj_…/threads/thr_… */
  path: string;
  /** Public origin for links in emails; null leaves links out. */
  origin: string | null;
};

export const KIND_LABELS: Record<NotificationKind, string> = {
  done: "Finished",
  ready: "New reply",
  decision: "Needs your decision",
  blocked: "Blocked",
  failed: "Failed",
};

/** Kinds worth an email. A new reply alone only goes to the app and push. */
const EMAIL_KINDS = new Set<NotificationKind>(["done", "decision", "blocked", "failed"]);

/**
 * Notifies every member of the project: always in the app's list, plus push
 * and email per their settings and what this server has configured. Delivery
 * failures are logged, never thrown, so they cannot break an agent turn.
 */
export async function deliverNotification(env: Env, input: NotifyInput): Promise<void> {
  const db = createDb(env.DB);
  const members = await db
    .select({ id: user.id, email: user.email })
    .from(projectMembers)
    .innerJoin(user, eq(user.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, input.projectId));
  if (members.length === 0) return;
  const ids = members.map((m) => m.id);

  const createdAt = new Date();
  const rows = members.map((m) => ({
    id: createId("notification"),
    userId: m.id,
    projectId: input.projectId,
    threadId: input.threadId,
    kind: input.kind,
    title: input.title,
    body: input.body,
    url: input.path,
    createdAt,
  }));
  // One statement per row keeps each under D1's bound-parameter limit.
  await db.batch(rows.map((r) => db.insert(notifications).values(r)) as [never, ...never[]]);

  const settings = new Map(
    (await db.select().from(notificationSettings).where(inArray(notificationSettings.userId, ids))).map((s) => [
      s.userId,
      s,
    ]),
  );
  const wantsPush = (id: string) => settings.get(id)?.push ?? true;
  const wantsEmail = (id: string) => settings.get(id)?.email ?? true;

  const heading = `${KIND_LABELS[input.kind]} · ${input.title}`;
  const jobs: Promise<unknown>[] = [];

  const subs = (await db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, ids))).filter((s) =>
    wantsPush(s.userId),
  );
  const vapid = vapidKeys(env);
  const payload = JSON.stringify({
    title: heading,
    body: input.body,
    url: input.path,
    tag: input.threadId ?? input.projectId,
    project: input.projectName,
  });
  const gone: string[] = [];
  for (const s of subs) {
    if (s.kind !== "webpush" || !vapid || !s.p256dh || !s.auth) continue;
    jobs.push(
      sendWebPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload, vapid, {
        urgency: input.kind === "ready" ? "normal" : "high",
        topic: input.threadId ?? undefined,
      }).then((res) => {
        if (res.status === 404 || res.status === 410) gone.push(s.endpoint);
        else if (!res.ok) console.warn("web push failed", res.status);
      }),
    );
  }
  const expo = subs.filter((s) => s.kind === "expo");
  if (expo.length) {
    jobs.push(
      sendExpoPush(
        env,
        expo.map((s) => ({
          to: s.endpoint,
          title: heading,
          body: input.body,
          data: { url: input.path, projectId: input.projectId, threadId: input.threadId },
        })),
      ).then((tokens) => gone.push(...tokens)),
    );
  }

  if (emailEnabled(env) && EMAIL_KINDS.has(input.kind)) {
    const link = input.origin ? `${input.origin}${input.path}` : null;
    for (const m of members) {
      if (!wantsEmail(m.id)) continue;
      jobs.push(
        sendEmail(env, { to: m.email, subject: `[${input.projectName}] ${heading}`, ...emailBody(input, link) }),
      );
    }
  }

  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === "rejected") console.warn("notification delivery failed", r.reason);
  }
  if (gone.length) await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.endpoint, gone));
}

function emailBody(input: NotifyInput, link: string | null) {
  const text = [input.body, link ? `Open: ${link}` : "", `— Myrel · ${input.projectName}`]
    .filter(Boolean)
    .join("\n\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;color:#18181b">
<p style="color:#71717a;font-size:13px;margin:0 0 4px">${esc(input.projectName)} · ${esc(KIND_LABELS[input.kind])}</p>
<h2 style="font-size:18px;margin:0 0 12px">${esc(input.title)}</h2>
<p style="white-space:pre-wrap;line-height:1.5">${esc(input.body)}</p>
${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#5b6cff;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none">Open thread</a></p>` : ""}
</div>`;
  return { text, html };
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Plain-text excerpt of a Markdown reply for a notification body. */
export function excerpt(markdown: string, max = 240): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}
