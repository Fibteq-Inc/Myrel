import { createDb, schema } from "@myrel/db";
import { type CatalogConnector, type CatalogPage, POPULAR_CATALOG_IDS } from "@myrel/protocol";
import { asc, count, desc, eq, inArray, type SQLWrapper, sql } from "drizzle-orm";
import { blockedUrl } from "./client";

const { connectorCatalog, connectorCatalogSync } = schema;

/**
 * The connector catalog: a copy of the remote servers in the official MCP Registry, which is open
 * for clients and sub-registries to read (https://registry.modelcontextprotocol.io/docs). A cron
 * copies it every hour (syncCatalog); the settings search the copy (searchCatalog).
 */
export const DEFAULT_REGISTRY_URL = "https://registry.modelcontextprotocol.io";
const SYNC_ID = "registry";
const PAGE_SIZE = 100;
/** A run stops here and the next one continues; the first copy is ~200 pages. */
const MAX_PAGES = 400;
const TIMEOUT_MS = 20_000;

/** The parts of a registry entry the catalog reads (server.schema.json). */
type RegistryEntry = {
  server: {
    name: string;
    title?: string;
    description?: string;
    version: string;
    websiteUrl?: string;
    icons?: { src: string; mimeType?: string; theme?: string }[];
    remotes?: {
      type: string;
      url: string;
      headers?: { name: string; description?: string; isRequired?: boolean; isSecret?: boolean; placeholder?: string }[];
      variables?: Record<string, unknown>;
    }[];
  };
  _meta?: { "io.modelcontextprotocol.registry/official"?: { status?: string; updatedAt?: string; isLatest?: boolean } };
};

type CatalogRow = typeof connectorCatalog.$inferInsert;

/** A registry entry as a catalog row, or null when Myrel cannot add it (no public streamable HTTP address). */
export function catalogRow(entry: RegistryEntry, now: Date): CatalogRow | null {
  const s = entry.server;
  const meta = entry._meta?.["io.modelcontextprotocol.registry/official"];
  if (meta?.status && meta.status !== "active") return null;
  // The gateway speaks streamable HTTP; an address with {placeholders} needs values the registry doesn't give.
  const remote = s.remotes?.find((r) => r.type === "streamable-http" && !/[{}]/.test(r.url) && !r.variables && !blockedUrl(r.url));
  if (!remote) return null;
  const header = remote.headers?.find((h) => h.isRequired);
  const icon = s.icons?.find((i) => i.src.startsWith("https://") && i.theme !== "dark") ?? s.icons?.find((i) => i.src.startsWith("https://"));
  return {
    id: s.name,
    title: clip(s.title?.trim() || titleFromName(s.name), 80),
    description: clip(s.description?.trim() ?? "", 300),
    websiteUrl: s.websiteUrl?.startsWith("https://") ? clip(s.websiteUrl, 500) : null,
    iconUrl: icon ? clip(icon.src, 500) : null,
    url: remote.url,
    auth: header ? "headers" : "oauth",
    headerName: header?.name ?? null,
    headerPlaceholder: header ? clip(header.placeholder || header.description || "", 200) : null,
    version: s.version,
    registryUpdatedAt: meta?.updatedAt ?? now.toISOString(),
    syncedAt: now,
  };
}

/** "com.notion/mcp" → "Notion", "app.linear/linear" → "Linear", "io.github.acme/weather-tools" → "Weather Tools". */
export function titleFromName(name: string): string {
  const [namespace = "", server = ""] = name.split("/");
  const generic = /^(mcp|mcp-server|server|remote|remote-mcp|api)$/i.test(server);
  const domain = namespace.split(".");
  const word = generic || !server ? (domain[1] ?? domain[0] ?? name) : server;
  return word
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Copies what changed in the registry since the last finished run (everything on the first run).
 * Removed, deprecated and no longer reachable servers leave the catalog. Returns how many entries
 * were read and kept.
 */
export async function syncCatalog(env: Env, fetcher: typeof fetch = fetch, now = new Date()) {
  const db = createDb(env.DB);
  const base = (env.CONNECTOR_REGISTRY_URL || DEFAULT_REGISTRY_URL).replace(/\/$/, "");
  const [state] = await db.select().from(connectorCatalogSync).where(eq(connectorCatalogSync.id, SYNC_ID));
  // Changes made while a run reads are picked up by the next one: it starts from this run's start.
  const startedAt = new Date(now.getTime() - 60_000).toISOString();
  let cursor = state?.cursor ?? null;
  let read = 0;
  let kept = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${base}/v0/servers`);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("version", "latest");
    if (state?.since) url.searchParams.set("updated_since", state.since);
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`The MCP Registry answered HTTP ${res.status}.`);
    const body = (await res.json()) as { servers?: RegistryEntry[]; metadata?: { nextCursor?: string } };
    const entries = body.servers ?? [];
    read += entries.length;
    const rows = entries.map((e) => catalogRow(e, now));
    const keep = rows.filter((r): r is CatalogRow => !!r);
    const drop = entries.filter((_, i) => !rows[i]).map((e) => e.server.name);
    kept += keep.length;
    await saveRows(db, keep, drop);
    cursor = body.metadata?.nextCursor || null;
    // Remember the page, so a run that stops early (time, an error) continues from it.
    await saveState(db, { since: state?.since ?? null, cursor });
    if (!cursor || !entries.length) {
      await saveState(db, { since: startedAt, cursor: null });
      break;
    }
  }
  return { read, kept };
}

async function saveRows(db: ReturnType<typeof createDb>, rows: CatalogRow[], drop: string[]) {
  // D1 takes up to 100 bound values per statement; a row has 12.
  const statements = [];
  for (let i = 0; i < rows.length; i += 8) {
    const chunk = rows.slice(i, i + 8);
    statements.push(
      db
        .insert(connectorCatalog)
        .values(chunk)
        .onConflictDoUpdate({
          target: connectorCatalog.id,
          set: Object.fromEntries(
            ["title", "description", "website_url", "icon_url", "url", "auth", "header_name", "header_placeholder", "version", "registry_updated_at", "synced_at"].map((c) => [
              toCamel(c),
              sql.raw(`excluded.${c}`),
            ]),
          ),
        }),
    );
  }
  for (let i = 0; i < drop.length; i += 90) statements.push(db.delete(connectorCatalog).where(inArray(connectorCatalog.id, drop.slice(i, i + 90))));
  if (statements.length) await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
}

function toCamel(column: string) {
  return column.replace(/_(\w)/g, (_, ch: string) => ch.toUpperCase());
}

async function saveState(db: ReturnType<typeof createDb>, state: { since: string | null; cursor: string | null }) {
  const row = { id: SYNC_ID, ...state, updatedAt: new Date() };
  await db.insert(connectorCatalogSync).values(row).onConflictDoUpdate({ target: connectorCatalogSync.id, set: row });
}

/**
 * Searches the catalog. Without a query the well-known services come first, in their order, then
 * servers with an icon and a website (usually real products) before the rest.
 */
export async function searchCatalog(env: Env, opts: { q?: string; offset?: number; limit?: number }): Promise<CatalogPage> {
  const db = createDb(env.DB);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 60);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = opts.q?.trim().slice(0, 100);
  const pattern = q ? `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const like = (column: SQLWrapper) => sql`${column} like ${pattern} escape '\\'`;
  const popularRank = sql`case ${connectorCatalog.id} ${sql.join(
    POPULAR_CATALOG_IDS.map((id, i) => sql`when ${id} then ${i}`),
    sql` `,
  )} else ${POPULAR_CATALOG_IDS.length} end`;
  // A name match ranks above a match in the description.
  const titleMatch = pattern ? [sql`case when ${like(connectorCatalog.title)} then 0 else 1 end`] : [];
  const rows = await db
    .select()
    .from(connectorCatalog)
    .where(pattern ? sql`(${like(connectorCatalog.title)} or ${like(connectorCatalog.id)} or ${like(connectorCatalog.description)})` : undefined)
    .orderBy(
      popularRank,
      ...titleMatch,
      desc(sql`${connectorCatalog.iconUrl} is not null and ${connectorCatalog.websiteUrl} is not null`),
      asc(sql`lower(${connectorCatalog.title})`),
      asc(connectorCatalog.id),
    )
    .limit(limit + 1)
    .offset(offset);
  const [state] = await db.select().from(connectorCatalogSync).where(eq(connectorCatalogSync.id, SYNC_ID));
  const popular = new Set(POPULAR_CATALOG_IDS);
  return {
    connectors: rows.slice(0, limit).map(
      (r): CatalogConnector => ({
        id: r.id,
        title: r.title,
        description: r.description,
        websiteUrl: r.websiteUrl,
        iconUrl: r.iconUrl,
        url: r.url,
        auth: r.auth,
        headerHint: r.headerName ? { name: r.headerName, placeholder: r.headerPlaceholder ?? "" } : null,
        popular: popular.has(r.id),
      }),
    ),
    nextOffset: rows.length > limit ? offset + limit : null,
    // A finished run leaves `since`; until the first one finishes the catalog is still filling.
    syncedAt: state?.since ? state.updatedAt.toISOString() : null,
  };
}

/** How many servers the catalog has; for tests and diagnostics. */
export async function catalogSize(env: Env) {
  const [row] = await createDb(env.DB).select({ n: count() }).from(connectorCatalog);
  return row?.n ?? 0;
}
