import { createDb, schema } from "@myrel/db";
import { CONNECTOR_PRESETS, type ConnectorOffer, createId, OFFICIAL_CATALOG_IDS } from "@myrel/protocol";
import { and, eq, inArray, or } from "drizzle-orm";
import { canAddConnector } from "../extensions";
import { searchCatalog } from "./catalog";
import { blockedUrl } from "./client";
import { type SignInReturn, startAuthorization } from "./oauth";
import { checkConnector, type ConnectorRow, freeSlug, sealSecrets } from "./store";

const { connectors, connectorCatalog, projectConnectors } = schema;

/**
 * Connectors the thread's agent can offer the person when the work needs a service it cannot
 * reach: Myrel's remote presets and the catalog (see catalog.ts). The person connects one from the
 * card as their own connector, on in that project (see connectOffer).
 */
const PRESET_PREFIX = "preset:";

function presetOffers(): ConnectorOffer[] {
  return CONNECTOR_PRESETS.flatMap((p) =>
    p.transport === "http"
      ? [
          {
            id: `${PRESET_PREFIX}${p.id}`,
            name: p.name,
            description: p.description,
            url: p.url,
            auth: p.auth,
            headerHint: p.headerHint ?? null,
            iconUrl: null,
            official: false,
            featured: p.featured ?? false,
          },
        ]
      : [],
  );
}

/** Offers matching a search: Myrel's presets first, then the catalog. */
export async function searchOffers(env: Env, q: string, limit = 8): Promise<ConnectorOffer[]> {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const presets = presetOffers().filter((o) => words.some((w) => `${o.name} ${o.description}`.toLowerCase().includes(w)));
  const page = await searchCatalog(env, { q, limit });
  // A search for several words also tries each word alone, so "cloudflare workers dns" finds Cloudflare.
  const extra = page.connectors.length < limit && words.length > 1 ? await Promise.all(words.map((w) => searchCatalog(env, { q: w, limit: 4 }))) : [];
  const seen = new Set<string>();
  const out: ConnectorOffer[] = [];
  for (const o of [...presets, ...[page, ...extra].flatMap((p) => p.connectors.map(toOffer))]) {
    if (seen.has(o.id) || seen.has(o.url)) continue;
    seen.add(o.id);
    seen.add(o.url);
    out.push(o);
  }
  return out.slice(0, limit);
}

function toOffer(e: {
  id: string;
  title: string;
  description: string;
  url: string;
  auth: "oauth" | "headers";
  headerHint: { name: string; placeholder: string } | null;
  iconUrl: string | null;
  official?: boolean;
}): ConnectorOffer {
  return {
    id: e.id,
    name: e.title.slice(0, 80),
    description: e.description.slice(0, 300),
    url: e.url,
    auth: e.auth,
    headerHint: e.headerHint,
    // Only the official servers load an icon of their own: the rest would tell their hosts who opened the thread.
    iconUrl: e.official ? e.iconUrl : null,
    official: !!e.official,
    featured: false,
  };
}

/** The offers with these ids, in the order given; unknown ids are left out. */
export async function findOffers(env: Env, ids: string[]): Promise<ConnectorOffer[]> {
  const presets = presetOffers();
  const catalogIds = ids.filter((id) => !id.startsWith(PRESET_PREFIX));
  const rows = catalogIds.length ? await createDb(env.DB).select().from(connectorCatalog).where(inArray(connectorCatalog.id, catalogIds)) : [];
  const official = new Set(OFFICIAL_CATALOG_IDS);
  return ids.flatMap((id) => {
    const preset = presets.find((p) => p.id === id);
    if (preset) return [preset];
    const r = rows.find((row) => row.id === id);
    if (!r) return [];
    return [
      toOffer({
        ...r,
        headerHint: r.headerName ? { name: r.headerName, placeholder: r.headerPlaceholder ?? "" } : null,
        official: official.has(r.id),
      }),
    ];
  });
}

/** How an address is already connected for this thread: on (the agent has it), off in the project, or signed out. */
export type KnownState = "on" | "off_in_project" | "needs_sign_in";

/** The remote connectors that the project and the person already have, by address. */
export async function knownConnectors(env: Env, projectId: string, userId: string | null): Promise<Map<string, KnownState>> {
  const db = createDb(env.DB);
  const rows = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.transport, "http"), userId ? or(eq(connectors.projectId, projectId), eq(connectors.ownerId, userId)) : eq(connectors.projectId, projectId)));
  const links = userId
    ? await db.select({ id: projectConnectors.connectorId }).from(projectConnectors).where(eq(projectConnectors.projectId, projectId))
    : [];
  const on = new Set(links.map((l) => l.id));
  const known = new Map<string, KnownState>();
  const rank: Record<KnownState, number> = { on: 0, needs_sign_in: 1, off_in_project: 2 };
  for (const row of rows) {
    if (!row.url) continue;
    const state: KnownState =
      row.auth === "oauth" && row.status === "needs_auth"
        ? "needs_sign_in"
        : !row.enabled || (row.ownerId && !on.has(row.id))
          ? "off_in_project"
          : "on";
    const before = known.get(row.url);
    if (!before || rank[state] < rank[before]) known.set(row.url, state);
  }
  return known;
}

export type ConnectResult =
  | { ok: true; connected: true; connectorId: string }
  | { ok: true; connected: false; authorizeUrl: string }
  | { ok: false; error: "limit_reached" | "invalid_input" | "failed"; message: string };

/**
 * Connects an offer as the person's own connector and turns it on in the project: an existing one
 * at the same address is reused (signed in again when it has to be), else a new one is added,
 * within the plan's limit. A sign-in comes back to `back`'s thread.
 */
export async function connectOffer(
  env: Env,
  input: { userId: string; projectId: string; offer: ConnectorOffer; headers?: Record<string, string>; origin: string; back: SignInReturn },
): Promise<ConnectResult> {
  const { userId, projectId, offer } = input;
  const blocked = blockedUrl(offer.url);
  if (blocked) return { ok: false, error: "invalid_input", message: blocked };
  const db = createDb(env.DB);
  const [existing] = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.ownerId, userId), eq(connectors.url, offer.url)));
  let row: ConnectorRow;
  if (existing) {
    row = existing;
    if (!row.enabled) {
      row = { ...row, enabled: true };
      await db.update(connectors).set({ enabled: true, updatedAt: new Date() }).where(eq(connectors.id, row.id));
    }
    if (input.headers && row.auth !== "oauth") {
      Object.assign(row, await sealSecrets(env, row.id, input.headers), { auth: "headers" as const });
      await db.update(connectors).set({ secret: row.secret, secretNames: row.secretNames, auth: "headers" }).where(eq(connectors.id, row.id));
    }
  } else {
    const allowed = await canAddConnector(env, { userId });
    if (!allowed.ok) return { ok: false, error: "limit_reached", message: allowed.reason };
    if (offer.auth === "headers" && !input.headers) return { ok: false, error: "invalid_input", message: `${offer.headerHint?.name ?? "A key"} is needed.` };
    const id = createId("connector");
    const now = new Date();
    const secrets = offer.auth === "headers" ? (input.headers ?? {}) : {};
    row = {
      id,
      ownerId: userId,
      projectId: null,
      name: offer.name.slice(0, 60),
      slug: await freeSlug(env, { userId }, offer.name),
      transport: "http",
      url: offer.url,
      auth: offer.auth === "oauth" ? "oauth" : "headers",
      command: null,
      args: [],
      runsOn: "both",
      ...(await sealSecrets(env, id, secrets)),
      enabled: true,
      status: offer.auth === "oauth" ? "needs_auth" : "unknown",
      lastError: null,
      tools: [],
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(connectors).values(row);
  }
  await db.insert(projectConnectors).values({ projectId, connectorId: row.id }).onConflictDoNothing();

  if (row.auth === "oauth" && row.status !== "ok") {
    try {
      return { ok: true, connected: false, authorizeUrl: await startAuthorization(env, row, input.origin, userId, fetch, input.back) };
    } catch (err) {
      // A server without a sign-in may need none at all (catalog entries don't say): try it as it is.
      const open = await checkConnector(env, { ...row, auth: "none" });
      if (open.status !== "ok") {
        const message = err instanceof Error ? err.message : String(err);
        await db.update(connectors).set({ status: "error", lastError: message }).where(eq(connectors.id, row.id));
        return { ok: false, error: "failed", message };
      }
      await db.update(connectors).set({ auth: "none", ...open }).where(eq(connectors.id, row.id));
      return { ok: true, connected: true, connectorId: row.id };
    }
  }
  const checked = await checkConnector(env, row);
  await db.update(connectors).set({ ...checked, updatedAt: new Date() }).where(eq(connectors.id, row.id));
  if (checked.status === "error") return { ok: false, error: "failed", message: checked.lastError ?? "The server did not answer." };
  return { ok: true, connected: true, connectorId: row.id };
}
