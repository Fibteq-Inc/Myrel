import { createDb, schema } from "@myrel/db";
import { type CreateReportInput, createId, type ReportReason } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { and, count, eq, gt, inArray, ne } from "drizzle-orm";
import { adminEmails } from "./instance";
import { emailEnabled, sendEmail } from "./notifications/channels";

const { contentReports, projectMembers, user, userBlocks } = schema;

/**
 * Reporting content and blocking people (App Store Guideline 1.2). A report is kept in D1 with a
 * copy of what was reported and emailed to the server's admins and REPORTS_EMAIL; a block hides the
 * blocked person's messages from the one who blocked them (the apps filter on Member.blocked) and
 * tells the project's owners and admins, who can remove the member.
 */

/** Reports one person may file in an hour, so the admins' inbox cannot be flooded. */
const REPORTS_PER_HOUR = 20;
const EXCERPT_MAX = 4000;

const REASON_LABELS: Record<ReportReason, string> = {
  spam: "Spam",
  harassment: "Harassment or bullying",
  hate: "Hate speech",
  sexual: "Sexual content",
  violence: "Violence or threats",
  illegal: "Illegal content",
  other: "Something else",
};

type Person = { id: string; name: string; email: string };
type ProjectRef = { id: string; name: string };

export type ReportResult =
  | { ok: true; id: string; duplicate: boolean }
  | { ok: false; status: 404 | 429; error: "not_found" | "rate_limited" };

/** Files a report on a message or artifact of `project`. The reporter must be a member (the route checks). */
export async function reportContent(
  env: Env,
  input: { project: ProjectRef; reporter: Person; report: CreateReportInput; origin: string },
): Promise<ReportResult> {
  const { project, reporter, report } = input;
  const target = await findTarget(env, project.id, report.target);
  if (!target) return { ok: false, status: 404, error: "not_found" };

  const db = createDb(env.DB);
  const [recent] = await db
    .select({ n: count() })
    .from(contentReports)
    .where(and(eq(contentReports.reporterId, reporter.id), gt(contentReports.createdAt, new Date(Date.now() - 3_600_000))));
  if ((recent?.n ?? 0) >= REPORTS_PER_HOUR) return { ok: false, status: 429, error: "rate_limited" };

  const id = createId("report");
  const note = report.note?.trim() || null;
  const inserted = await db
    .insert(contentReports)
    .values({
      id,
      reporterId: reporter.id,
      projectId: project.id,
      threadId: target.threadId,
      kind: report.target.kind,
      targetId: target.id,
      version: target.version,
      authorKind: target.authorKind,
      authorId: target.authorId,
      reason: report.reason,
      note,
      excerpt: target.excerpt.slice(0, EXCERPT_MAX),
    })
    .onConflictDoNothing()
    .returning({ id: contentReports.id });
  // The same person reporting the same thing again: already with the admins.
  if (inserted.length === 0) return { ok: true, id, duplicate: true };

  const author =
    target.authorKind === "user"
      ? (await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, target.authorId)))[0]
      : undefined;
  await mailSafely(env, await reportRecipients(env), (to) =>
    reportEmail(to, {
      id,
      project,
      reporter,
      reason: report.reason,
      note,
      kind: report.target.kind,
      authorLabel:
        target.authorKind === "user"
          ? `${author?.name ?? "A former member"}${author ? ` <${author.email}>` : ""} (person, ${target.authorId})`
          : target.authorKind === "agent"
            ? "An agent (AI-generated)"
            : "Myrel (system message)",
      title: target.title,
      excerpt: target.excerpt,
      link: `${input.origin}${target.path}`,
    }),
  );
  return { ok: true, id, duplicate: false };
}

type Target = {
  id: string;
  threadId: string | null;
  version: number | null;
  authorKind: string;
  authorId: string;
  title: string | null;
  excerpt: string;
  /** Where it is seen in the app. */
  path: string;
};

async function findTarget(env: Env, projectId: string, target: CreateReportInput["target"]): Promise<Target | null> {
  const agent = await getAgentByName(env.PROJECT_AGENT, projectId);
  const base = `/projects/${encodeURIComponent(projectId)}`;
  if (target.kind === "message") {
    const message = await agent.getMessage(target.messageId);
    if (!message || message.projectId !== projectId) return null;
    const files = message.attachments?.map((a) => a.path) ?? [];
    return {
      id: message.id,
      threadId: message.threadId,
      version: null,
      authorKind: message.authorKind,
      authorId: message.authorId,
      title: null,
      excerpt: [message.body, files.length ? `Attached files: ${files.join(", ")}` : ""].filter(Boolean).join("\n\n"),
      path: message.threadId ? `${base}/threads/${encodeURIComponent(message.threadId)}` : base,
    };
  }
  const found = await agent.getArtifact(target.artifactId);
  if (!found) return null;
  const version = target.version ?? found.artifact.version;
  if (!found.versions.some((v) => v.version === version)) return null;
  return {
    id: found.artifact.id,
    threadId: found.artifact.threadId ?? null,
    version,
    authorKind: "agent",
    authorId: found.artifact.threadId ?? "coordinator",
    title: found.artifact.title,
    excerpt: `Artifact "${found.artifact.title}", version ${version}`,
    path: `${base}/artifacts/${encodeURIComponent(found.artifact.id)}`,
  };
}

/** The server's admins (stored role or ADMIN_EMAILS) and REPORTS_EMAIL, each address once. */
async function reportRecipients(env: Env): Promise<string[]> {
  const admins = await createDb(env.DB).select({ email: user.email }).from(user).where(eq(user.role, "admin"));
  const extra = (env.REPORTS_EMAIL ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  return unique([...admins.map((a) => a.email), ...adminEmails(env), ...extra]);
}

function reportEmail(
  to: string,
  r: {
    id: string;
    project: ProjectRef;
    reporter: Person;
    reason: ReportReason;
    note: string | null;
    kind: "message" | "artifact";
    authorLabel: string;
    title: string | null;
    excerpt: string;
    link: string;
  },
) {
  const what = r.kind === "message" ? "a message" : "an artifact";
  const excerpt = r.excerpt.length > 2000 ? `${r.excerpt.slice(0, 1999)}…` : r.excerpt;
  const rows: [string, string][] = [
    ["Reason", REASON_LABELS[r.reason]],
    ...(r.note ? ([["Note", r.note]] as [string, string][]) : []),
    ["Reported by", `${r.reporter.name} <${r.reporter.email}> (${r.reporter.id})`],
    ["Project", `${r.project.name} (${r.project.id})`],
    ["Written by", r.authorLabel],
    ["Report", r.id],
  ];
  const text = [
    `${r.reporter.name} reported ${what} on Myrel. Review it within 24 hours: remove the content and the person who posted it if it breaks the terms.`,
    rows.map(([k, v]) => `${k}: ${v}`).join("\n"),
    `Reported content:\n${excerpt}`,
    `Open: ${r.link}`,
  ].join("\n\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:600px;color:#18181b">
<h2 style="font-size:18px;margin:0 0 8px">${esc(r.reporter.name)} reported ${what}</h2>
<p style="line-height:1.5;margin:0 0 12px">Review it within 24 hours: remove the content and the person who posted it if it breaks the terms.</p>
<table style="border-collapse:collapse;font-size:14px;margin:0 0 12px">${rows
    .map(([k, v]) => `<tr><td style="color:#71717a;padding:2px 12px 2px 0;vertical-align:top">${esc(k)}</td><td style="padding:2px 0">${esc(v)}</td></tr>`)
    .join("")}</table>
<p style="white-space:pre-wrap;line-height:1.5;border-left:3px solid #e4e4e7;padding-left:12px">${esc(excerpt)}</p>
<p><a href="${esc(r.link)}" style="display:inline-block;background:#5b6cff;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none">Open in Myrel</a></p>
</div>`;
  return { to, subject: `[Report] ${REASON_LABELS[r.reason]} · ${r.project.name}`, text, html };
}

// ---- Blocking ----------------------------------------------------------------

/** The ids of the people `userId` blocked. */
export async function blockedIds(env: Env, userId: string): Promise<Set<string>> {
  const rows = await createDb(env.DB)
    .select({ id: userBlocks.blockedId })
    .from(userBlocks)
    .where(eq(userBlocks.blockerId, userId));
  return new Set(rows.map((r) => r.id));
}

/**
 * `blocker` blocks `blockedId`, a member of `project`. The first time, the project's other owners and
 * admins are emailed so they can look into it (and remove the member). Returns false when it already was.
 */
export async function blockMember(
  env: Env,
  input: { project: ProjectRef; blocker: Person; blockedId: string; origin: string },
): Promise<boolean> {
  const { project, blocker, blockedId } = input;
  const db = createDb(env.DB);
  const inserted = await db
    .insert(userBlocks)
    .values({ blockerId: blocker.id, blockedId, projectId: project.id })
    .onConflictDoNothing()
    .returning({ id: userBlocks.blockedId });
  if (inserted.length === 0) return false;

  const [blocked] = await db.select({ name: user.name }).from(user).where(eq(user.id, blockedId));
  const managers = await db
    .select({ email: user.email })
    .from(projectMembers)
    .innerJoin(user, eq(user.id, projectMembers.userId))
    .where(
      and(
        eq(projectMembers.projectId, project.id),
        inArray(projectMembers.role, ["owner", "admin"]),
        ne(projectMembers.userId, blocker.id),
        ne(projectMembers.userId, blockedId),
      ),
    );
  const link = `${input.origin}/settings/projects/${encodeURIComponent(project.id)}?tab=members`;
  const name = blocked?.name ?? "a member";
  await mailSafely(env, unique(managers.map((m) => m.email)), (to) => ({
    to,
    subject: `[${project.name}] ${blocker.name} blocked ${name}`,
    text: [
      `${blocker.name} blocked ${name} in the project "${project.name}" on Myrel. ${blocker.name} no longer sees ${name}'s messages.`,
      `If ${name} is abusing the project, you can remove them in the project's Settings › Members.`,
      `${blocker.name}, "${project.name}" projesinde ${name} adlı üyeyi engelledi. Gerekirse üyeyi proje ayarlarında Üyeler bölümünden çıkarabilirsin.`,
      `Open: ${link}`,
    ].join("\n\n"),
    html: `<div style="font-family:system-ui,sans-serif;max-width:560px;color:#18181b">
<h2 style="font-size:18px;margin:0 0 12px">${esc(blocker.name)} blocked ${esc(name)} in ${esc(project.name)}</h2>
<p style="line-height:1.5">${esc(blocker.name)} no longer sees ${esc(name)}'s messages. If ${esc(name)} is abusing the project, you can remove them in the project's Settings › Members.</p>
<p style="line-height:1.5">${esc(blocker.name)}, <b>${esc(project.name)}</b> projesinde ${esc(name)} adlı üyeyi engelledi. Gerekirse üyeyi proje ayarlarında Üyeler bölümünden çıkarabilirsin.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#5b6cff;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none">Open members · Üyeleri aç</a></p>
</div>`,
  }));
  return true;
}

export async function unblockMember(env: Env, blockerId: string, blockedId: string): Promise<void> {
  await createDb(env.DB)
    .delete(userBlocks)
    .where(and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId)));
}

// ---- Helpers -----------------------------------------------------------------

type Mail = { to: string; subject: string; text: string; html: string };

/** Sends one email per address when email is set up. Failures are logged: the record is what counts. */
async function mailSafely(env: Env, to: string[], build: (to: string) => Mail): Promise<void> {
  if (!emailEnabled(env)) {
    if (to.length) console.warn("moderation email skipped: email is not configured");
    return;
  }
  for (const r of await Promise.allSettled(to.map((address) => sendEmail(env, build(address))))) {
    if (r.status === "rejected") console.warn("moderation email failed", r.reason);
  }
}

function unique(addresses: string[]): string[] {
  const seen = new Set<string>();
  return addresses.filter((a) => {
    const key = a.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
