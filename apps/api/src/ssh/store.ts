import { createDb, schema } from "@myrel/db";
import { createId, type SshAuditEntry, type SshHost, type SshTarget } from "@myrel/protocol";
import { and, desc, eq, gte } from "drizzle-orm";

/**
 * The project's SSH servers and their history (see @myrel/protocol ssh.ts). Nothing secret is here:
 * the keys stay on the computer that holds them.
 */

const { projectSshHosts, sshAudit, runners, user } = schema;

export type SshHostRow = typeof projectSshHosts.$inferSelect;

/** How long the SSH history is kept and shown. */
export const SSH_HISTORY_DAYS = 90;
/** How much of a command's output the history keeps. */
const AUDIT_OUTPUT = 2048;

export async function projectSshHostRows(env: Env, projectId: string, runnerId?: string): Promise<SshHostRow[]> {
  return createDb(env.DB)
    .select()
    .from(projectSshHosts)
    .where(and(eq(projectSshHosts.projectId, projectId), runnerId ? eq(projectSshHosts.runnerId, runnerId) : undefined))
    .orderBy(projectSshHosts.alias);
}

export async function findSshHost(env: Env, projectId: string, hostId: string): Promise<SshHostRow | null> {
  const [row] = await createDb(env.DB)
    .select()
    .from(projectSshHosts)
    .where(and(eq(projectSshHosts.projectId, projectId), eq(projectSshHosts.id, hostId)));
  return row ?? null;
}

/** The servers as the settings show them to `userId`, with their computer's name. */
export async function presentSshHosts(env: Env, rows: SshHostRow[], userId: string): Promise<SshHost[]> {
  const ids = [...new Set(rows.map((r) => r.runnerId))];
  const owners = new Map<string, { name: string; userId: string }>();
  for (const id of ids) {
    const [r] = await createDb(env.DB).select({ name: runners.name, userId: runners.userId }).from(runners).where(eq(runners.id, id));
    if (r) owners.set(id, r);
  }
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    alias: r.alias,
    host: r.host,
    port: r.port,
    user: r.user,
    runnerId: r.runnerId,
    runnerName: owners.get(r.runnerId)?.name ?? "",
    mine: owners.get(r.runnerId)?.userId === userId,
    keySource: r.keySource,
    publicKey: r.publicKey,
    keyFingerprint: r.keyFingerprint,
    hostFingerprint: r.hostFingerprint,
    rule: r.rule,
    testedAt: r.testedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Where a command for this server goes; null until the person confirmed the server's key. */
export function sshTarget(row: SshHostRow): SshTarget | null {
  if (!row.hostKey) return null;
  return { projectId: row.projectId, alias: row.alias, host: row.host, port: row.port, user: row.user, hostKey: row.hostKey };
}

/**
 * The server an agent means by `name`: its alias, or its address (with or without the user), so
 * `ssh deploy@203.0.113.10 …` finds the server registered as prod-web.
 */
export function matchSshHost(rows: SshHostRow[], name: string): SshHostRow | null {
  const raw = name.trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  const who = at >= 0 ? raw.slice(0, at) : null;
  const host = (at >= 0 ? raw.slice(at + 1) : raw).replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const fits = (r: SshHostRow) => !who || r.user.toLowerCase() === who;
  return rows.find((r) => r.alias === host && fits(r)) ?? rows.find((r) => r.host.toLowerCase().replace(/^\[|\]$/g, "") === host && fits(r)) ?? null;
}

export type SshAuditInput = {
  projectId: string;
  hostId: string | null;
  alias: string;
  threadId: string | null;
  command: string;
  reason: string | null;
  decision: SshAuditEntry["decision"];
  approvedBy: string | null;
  exitCode?: number | null;
  ms?: number | null;
  output?: string | null;
};

/** Writes one line of the project's SSH history. Known secrets in the output are masked. */
export async function recordSshAudit(env: Env, entry: SshAuditInput): Promise<void> {
  await createDb(env.DB)
    .insert(sshAudit)
    .values({
      id: createId("sshRun"),
      ...entry,
      command: entry.command.slice(0, 4000),
      reason: entry.reason?.slice(0, 1000) ?? null,
      exitCode: entry.exitCode ?? null,
      ms: entry.ms ?? null,
      output: entry.output ? maskSecrets(entry.output.slice(0, AUDIT_OUTPUT)) : null,
    });
}

/** The project's SSH history of the last SSH_HISTORY_DAYS, newest first, with who answered by name. */
export async function sshHistory(env: Env, projectId: string, limit = 100): Promise<SshAuditEntry[]> {
  const since = new Date(Date.now() - SSH_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const rows = await createDb(env.DB)
    .select({ entry: sshAudit, name: user.name })
    .from(sshAudit)
    .leftJoin(user, eq(user.id, sshAudit.approvedBy))
    .where(and(eq(sshAudit.projectId, projectId), gte(sshAudit.at, since)))
    .orderBy(desc(sshAudit.at))
    .limit(limit);
  return rows.map(({ entry, name }) => ({
    id: entry.id,
    alias: entry.alias,
    threadId: entry.threadId,
    command: entry.command,
    reason: entry.reason,
    decision: entry.decision,
    approvedBy: name ?? null,
    exitCode: entry.exitCode,
    ms: entry.ms,
    at: entry.at.toISOString(),
  }));
}

/** Private keys, tokens and passwords that a command printed, before its output is kept. */
export function maskSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "[secret]")
    .replace(/\b([A-Za-z_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)[A-Za-z_]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1[secret]");
}
