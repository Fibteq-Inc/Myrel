import { createDb, schema } from "@myrel/db";
import { type Connector, connectorSlug, type ConnectorScope } from "@myrel/protocol";
import { and, eq, inArray } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../crypto";
import { type OfficialMark, officialMarks, sameAddress } from "./catalog";
import { probeConnector } from "./client";
import { accessToken } from "./oauth";

const { connectors, projectConnectors, runners } = schema;

export type ConnectorRow = typeof connectors.$inferSelect;

export function toConnector(row: ConnectorRow, canEdit: boolean, official: OfficialMark | null = null): Connector {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    scope: row.projectId ? "project" : "user",
    transport: row.transport,
    url: row.url,
    auth: row.auth,
    command: row.command,
    args: row.args,
    runsOn: row.runsOn,
    secretNames: row.secretNames,
    enabled: row.enabled,
    status: row.status,
    lastError: row.lastError,
    tools: row.tools,
    canEdit,
    createdAt: row.createdAt.toISOString(),
    official,
  };
}

/** Connectors as the settings show them, each marked official when its address is an official server's. */
export async function presentConnectors(env: Env, rows: ConnectorRow[], canEdit: boolean): Promise<Connector[]> {
  const marks = rows.some((r) => r.url) ? await officialMarks(env) : new Map<string, OfficialMark>();
  return rows.map((r) => toConnector(r, canEdit, (r.transport === "http" && r.url && marks.get(sameAddress(r.url))) || null));
}

/** One connector as the settings show it (see presentConnectors). */
export async function presentConnector(env: Env, row: ConnectorRow, canEdit: boolean): Promise<Connector> {
  const [connector] = await presentConnectors(env, [row], canEdit);
  return connector!;
}

/** A connector's headers (http) or environment variables (stdio). Not for OAuth connectors: see connectorHeaders. */
export async function readSecrets(env: Env, row: Pick<ConnectorRow, "id" | "secret">): Promise<Record<string, string>> {
  if (!row.secret) return {};
  return JSON.parse(await decryptSecret(env, row.secret, row.id)) as Record<string, string>;
}

export async function sealSecrets(env: Env, id: string, secrets: Record<string, string>) {
  const names = Object.keys(secrets);
  return { secret: names.length ? await encryptSecret(env, JSON.stringify(secrets), id) : null, secretNames: names };
}

/** A free server name for a new connector of this owner or project. */
export async function freeSlug(env: Env, owner: ConnectorOwner, wanted: string): Promise<string> {
  const rows = await createDb(env.DB)
    .select({ slug: connectors.slug })
    .from(connectors)
    .where(ownerWhere(owner));
  const taken = new Set(rows.map((r) => r.slug));
  const base = connectorSlug(wanted);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const slug = `${base.slice(0, 29)}-${i}`;
    if (!taken.has(slug)) return slug;
  }
}

export type ConnectorOwner = { userId: string } | { projectId: string };

export function ownerWhere(owner: ConnectorOwner) {
  return "userId" in owner ? eq(connectors.ownerId, owner.userId) : eq(connectors.projectId, owner.projectId);
}

export function ownerScope(owner: ConnectorOwner): ConnectorScope {
  return "userId" in owner ? "user" : "project";
}

export async function findConnector(env: Env, owner: ConnectorOwner, id: string): Promise<ConnectorRow | null> {
  const [row] = await createDb(env.DB)
    .select()
    .from(connectors)
    .where(and(eq(connectors.id, id), ownerWhere(owner)));
  return row ?? null;
}

/** One connector as a turn of the thread's agent sees it. */
export type TurnConnector = {
  id: string;
  /** Server name in the agent's config; unique within the turn. */
  name: string;
  title: string;
  transport: "http" | "stdio";
  /** stdio only. */
  command?: string;
  args?: string[];
  /** Sealed headers or variables (see readSecrets). Never leaves the server sealed or not, except a command's variables to where it starts. */
  secret: string | null;
};

/**
 * The connectors a thread's agent gets this turn: the project's, then those of the person the
 * thread works for that they turned on in this project. A person's own connectors never work for someone else's thread. stdio servers
 * only where they may start. On a computer (runnerId) that is not the person's own, none of theirs: their commands and
 * variables would go to someone else's computer, and its CLI would hold the turn token that opens their remote ones.
 */
export async function turnConnectors(
  env: Env,
  where: { projectId: string; userId: string | null; place: "cloud" | "local"; runnerId?: string },
): Promise<TurnConnector[]> {
  const db = createDb(env.DB);
  const [computer] =
    where.place === "local" && where.runnerId
      ? await db.select({ userId: runners.userId }).from(runners).where(eq(runners.id, where.runnerId))
      : [];
  const ownComputer = where.place === "cloud" || !where.runnerId || computer?.userId === where.userId;
  const project = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.projectId, where.projectId), eq(connectors.enabled, true)));
  // A person's own connectors only where they turned them on for this project.
  const own = where.userId && ownComputer
    ? (
        await db
          .select({ connector: connectors })
          .from(connectors)
          .innerJoin(
            projectConnectors,
            and(eq(projectConnectors.connectorId, connectors.id), eq(projectConnectors.projectId, where.projectId)),
          )
          .where(and(eq(connectors.ownerId, where.userId), eq(connectors.enabled, true)))
      ).map((r) => r.connector)
    : [];
  // A cloud turn's commands run in a sandbox whose shell sees their variables, so a project command
  // with secrets is only given to turns for its owners and admins, or for whoever set it.
  const [membership] = where.userId
    ? await db
        .select({ role: schema.projectMembers.role })
        .from(schema.projectMembers)
        .where(and(eq(schema.projectMembers.projectId, where.projectId), eq(schema.projectMembers.userId, where.userId)))
    : [];
  const manages = membership?.role === "owner" || membership?.role === "admin";
  const used = new Set(["myrel"]);
  const out: TurnConnector[] = [];
  for (const row of [...project, ...own]) {
    if (row.transport === "stdio" && row.runsOn !== "both" && row.runsOn !== where.place) continue;
    // A project's command starts on a computer only when its owner set that command (createdBy is
    // whoever last set it): another admin of the project cannot run one on their computer.
    if (row.transport === "stdio" && where.place === "local" && row.projectId && where.runnerId && row.createdBy !== computer?.userId) continue;
    if (row.transport === "stdio" && where.place === "cloud" && row.projectId && row.secret && !manages && row.createdBy !== where.userId) continue;
    if (row.transport === "http" && (!row.url || (row.auth === "oauth" && row.status === "needs_auth"))) continue;
    let name = row.slug;
    for (let i = 2; used.has(name); i++) name = `${row.slug.slice(0, 29)}-${i}`;
    used.add(name);
    out.push({
      id: row.id,
      name,
      title: row.name,
      transport: row.transport,
      ...(row.transport === "stdio" && { command: row.command ?? "", args: row.args }),
      secret: row.secret,
    });
  }
  return out;
}

/** The headers a remote connector's calls carry: its stored ones, or a fresh OAuth token. Null when someone has to sign in. */
export async function connectorHeaders(env: Env, row: ConnectorRow): Promise<Record<string, string> | null> {
  if (row.auth !== "oauth") return readSecrets(env, row);
  const token = await accessToken(env, row);
  return token ? { Authorization: `Bearer ${token}` } : null;
}

/** Where the gateway sends a remote connector's calls, with its headers. Null once it is gone, off or signed out. */
export async function remoteTarget(env: Env, id: string): Promise<{ url: string; headers: Record<string, string> } | null> {
  const [row] = await createDb(env.DB).select().from(connectors).where(eq(connectors.id, id));
  if (!row || !row.enabled || row.transport !== "http" || !row.url) return null;
  const headers = await connectorHeaders(env, row);
  return headers ? { url: row.url, headers } : null;
}

/**
 * Connects to a remote server and lists its tools. A command (stdio) only starts next to the
 * agent, so its tools are known once a run has used it.
 */
export async function checkConnector(env: Env, row: ConnectorRow): Promise<Pick<ConnectorRow, "status" | "lastError" | "tools">> {
  if (row.transport !== "http" || !row.url) return { status: "unknown", lastError: null, tools: row.tools };
  const headers = await connectorHeaders(env, row);
  if (!headers) return { status: "needs_auth", lastError: row.lastError, tools: row.tools };
  const probe = await probeConnector(row.url, headers);
  return probe.ok ? { status: "ok", lastError: null, tools: probe.tools } : { status: "error", lastError: probe.error, tools: row.tools };
}

/** How old a connector's tool list may get before a turn that uses it lists them again. */
export const TOOLS_FRESH_MS = 60 * 60 * 1000;

/**
 * Lists the tools again of the given remote connectors whose list is older than TOOLS_FRESH_MS,
 * so settings show what the server offers now. The agent itself always sees the live list through
 * the gateway; this only keeps the stored copy current. A failed listing changes nothing.
 */
export async function refreshStaleTools(env: Env, ids: string[], now = Date.now()): Promise<void> {
  if (!ids.length) return;
  const db = createDb(env.DB);
  const rows = await db.select().from(connectors).where(inArray(connectors.id, ids));
  await Promise.all(
    rows
      .filter((row) => row.transport === "http" && row.status === "ok" && now - row.updatedAt.getTime() >= TOOLS_FRESH_MS)
      .map(async (row) => {
        const next = await checkConnector(env, row);
        if (next.status !== "ok") return;
        await db.update(connectors).set({ tools: next.tools, updatedAt: new Date(now) }).where(eq(connectors.id, row.id));
      }),
  );
}
