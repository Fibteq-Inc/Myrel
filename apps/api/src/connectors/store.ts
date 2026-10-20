import { createDb, schema } from "@myrel/db";
import { type Connector, connectorSlug, type ConnectorScope } from "@myrel/protocol";
import { and, eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../crypto";
import { accessToken } from "./oauth";

const { connectors } = schema;

export type ConnectorRow = typeof connectors.$inferSelect;

export function toConnector(row: ConnectorRow, canEdit: boolean): Connector {
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
  };
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
 * thread works for. A person's own connectors never work for someone else's thread. stdio servers
 * only where they may start.
 */
export async function turnConnectors(
  env: Env,
  where: { projectId: string; userId: string | null; place: "cloud" | "local" },
): Promise<TurnConnector[]> {
  const db = createDb(env.DB);
  const project = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.projectId, where.projectId), eq(connectors.enabled, true)));
  const own = where.userId
    ? await db
        .select()
        .from(connectors)
        .where(and(eq(connectors.ownerId, where.userId), eq(connectors.enabled, true)))
    : [];
  const used = new Set(["myrel"]);
  const out: TurnConnector[] = [];
  for (const row of [...project, ...own]) {
    if (row.transport === "stdio" && row.runsOn !== "both" && row.runsOn !== where.place) continue;
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
