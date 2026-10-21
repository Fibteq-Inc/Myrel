import { createDb, schema } from "@myrel/db";
import { CatalogCategory, createId, CreateConnectorInput, UpdateConnectorInput } from "@myrel/protocol";
import { and, asc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { createAuth } from "../auth";
import { searchCatalog } from "../connectors/catalog";
import { blockedUrl } from "../connectors/client";
import { finishAuthorization, pendingSignIn, startAuthorization } from "../connectors/oauth";
import {
  type ConnectorOwner,
  checkConnector,
  type ConnectorRow,
  findConnector,
  freeSlug,
  ownerWhere,
  readSecrets,
  sealSecrets,
  toConnector,
} from "../connectors/store";
import { canAddConnector } from "../extensions";
import { type AppEnv, requireUser } from "../middleware";
import { findMembership } from "./projects";

const { connectors } = schema;

/** Who owns the connectors a request is about, and whether the caller may change them. */
type Scope = { owner: ConnectorOwner; canEdit: boolean };

/**
 * The same routes for a person's own connectors (/api/account/connectors) and a project's
 * (/api/projects/:id/connectors): list, add, change, remove, and check (connects and lists tools).
 */
function connectorRoutes(scope: (c: Context<AppEnv>) => Promise<Scope | null>) {
  return new Hono<AppEnv>()
    .use(requireUser)
    .get("/", async (c) => {
      const s = await scope(c);
      if (!s) return c.json({ error: "not_found" }, 404);
      const rows = await createDb(c.env.DB).select().from(connectors).where(ownerWhere(s.owner)).orderBy(asc(connectors.createdAt));
      return c.json({ connectors: rows.map((r) => toConnector(r, s.canEdit)) });
    })
    .post("/", async (c) => {
      const s = await scope(c);
      if (!s) return c.json({ error: "not_found" }, 404);
      if (!s.canEdit) return c.json({ error: "forbidden", message: "Only project owners and admins can add connectors." }, 403);
      const input = CreateConnectorInput.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
      const data = input.data;
      if (data.transport === "http") {
        const blocked = blockedUrl(data.url);
        if (blocked) return c.json({ error: "invalid_input", message: blocked }, 400);
      }
      const allowed = await canAddConnector(c.env, s.owner);
      if (!allowed.ok) return c.json({ error: "limit_reached", message: allowed.reason }, 402);

      const id = createId("connector");
      const now = new Date();
      const oauth = data.transport === "http" && data.auth === "oauth";
      const secrets = oauth ? {} : data.transport === "http" ? data.headers : data.env;
      const row: ConnectorRow = {
        id,
        ownerId: "userId" in s.owner ? s.owner.userId : null,
        projectId: "projectId" in s.owner ? s.owner.projectId : null,
        name: data.name,
        slug: await freeSlug(c.env, s.owner, data.slug ?? data.name),
        transport: data.transport,
        url: data.transport === "http" ? data.url : null,
        auth: data.transport === "stdio" ? "none" : oauth ? "oauth" : Object.keys(secrets).length ? "headers" : "none",
        command: data.transport === "stdio" ? data.command : null,
        args: data.transport === "stdio" ? data.args : [],
        runsOn: data.transport === "stdio" ? data.runsOn : "both",
        ...(await sealSecrets(c.env, id, secrets)),
        enabled: true,
        status: "unknown",
        lastError: null,
        tools: [],
        createdBy: c.get("user").id,
        createdAt: now,
        updatedAt: now,
      };
      if (oauth) {
        // Signing in starts right away; the row keeps the sign-in until the person comes back.
        row.status = "needs_auth";
        await createDb(c.env.DB).insert(connectors).values(row);
        try {
          const authorizeUrl = await startAuthorization(c.env, row, publicOrigin(c), c.get("user").id);
          return c.json({ connector: toConnector(row, true), authorizeUrl }, 201);
        } catch (err) {
          // A server without a sign-in may need none at all (catalog entries don't say): try it as it is.
          const open = await checkConnector(c.env, { ...row, auth: "none" });
          if (open.status === "ok") {
            const next = { ...row, auth: "none" as const, ...open };
            await createDb(c.env.DB).update(connectors).set({ auth: "none", ...open }).where(eq(connectors.id, id));
            return c.json({ connector: toConnector(next, true) }, 201);
          }
          const lastError = err instanceof Error ? err.message : String(err);
          await createDb(c.env.DB).update(connectors).set({ status: "error", lastError }).where(eq(connectors.id, id));
          return c.json({ connector: toConnector({ ...row, status: "error", lastError }, true) }, 201);
        }
      }
      Object.assign(row, await checkConnector(c.env, row));
      await createDb(c.env.DB).insert(connectors).values(row);
      return c.json({ connector: toConnector(row, true) }, 201);
    })
    .patch("/:connectorId", async (c) => {
      const s = await scope(c);
      if (!s) return c.json({ error: "not_found" }, 404);
      const row = await findConnector(c.env, s.owner, c.req.param("connectorId"));
      if (!row) return c.json({ error: "not_found" }, 404);
      if (!s.canEdit) return c.json({ error: "forbidden" }, 403);
      const input = UpdateConnectorInput.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
      const { secrets: newSecrets, ...fields } = input.data;
      if (newSecrets && row.auth === "oauth") return c.json({ error: "invalid_input", message: "This connector signs in; it has no headers." }, 400);
      if (newSecrets && row.transport === "stdio" && Object.keys(newSecrets).some((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))) {
        return c.json({ error: "invalid_input", message: "Environment variable names may only have letters, digits and _." }, 400);
      }
      if (fields.url) {
        const blocked = blockedUrl(fields.url);
        if (blocked) return c.json({ error: "invalid_input", message: blocked }, 400);
      }
      const next: ConnectorRow = {
        ...row,
        ...(fields.name !== undefined && { name: fields.name }),
        ...(fields.enabled !== undefined && { enabled: fields.enabled }),
        ...(row.transport === "http" && fields.url !== undefined && { url: fields.url }),
        ...(row.transport === "stdio" && fields.command !== undefined && { command: fields.command }),
        ...(row.transport === "stdio" && fields.args !== undefined && { args: fields.args }),
        ...(row.transport === "stdio" && fields.runsOn !== undefined && { runsOn: fields.runsOn }),
        updatedAt: new Date(),
      };
      // Whoever sets a command (or its variables) answers for it: it then starts only on their own computer.
      if (row.transport === "stdio" && (fields.command !== undefined || fields.args !== undefined || newSecrets || fields.runsOn !== undefined)) {
        next.createdBy = c.get("user").id;
      }
      // A header goes to the server it was given for: a remote connector moving to another server
      // needs its headers entered again, not the stored ones sent there.
      const moved = row.transport === "http" && row.auth === "headers" && fields.url !== undefined && originOf(fields.url) !== originOf(row.url);
      if (moved && (!newSecrets || Object.values(newSecrets).some((v) => v === ""))) {
        return c.json({ error: "invalid_input", message: "This connector moves to another server: enter its headers again." }, 400);
      }
      if (newSecrets) {
        // An empty value keeps what is stored under that name; a name left out is removed.
        const stored = await readSecrets(c.env, row);
        const secrets = Object.fromEntries(Object.entries(newSecrets).map(([k, v]) => [k, v === "" ? (stored[k] ?? "") : v]));
        Object.assign(next, await sealSecrets(c.env, row.id, secrets));
        if (row.transport === "http") next.auth = Object.keys(secrets).length ? "headers" : "none";
      }
      // A new address needs a new sign-in: the old token was for the old server.
      if (row.auth === "oauth" && fields.url !== undefined && fields.url !== row.url) {
        Object.assign(next, { secret: null, status: "needs_auth" as const, lastError: null });
      } else if (newSecrets || fields.url !== undefined || fields.command !== undefined || fields.args !== undefined) {
        Object.assign(next, await checkConnector(c.env, next));
      }
      const { id: _, ...set } = next;
      await createDb(c.env.DB).update(connectors).set(set).where(eq(connectors.id, row.id));
      return c.json({ connector: toConnector(next, true) });
    })
    .delete("/:connectorId", async (c) => {
      const s = await scope(c);
      if (!s) return c.json({ error: "not_found" }, 404);
      const row = await findConnector(c.env, s.owner, c.req.param("connectorId"));
      if (!row) return c.json({ error: "not_found" }, 404);
      if (!s.canEdit) return c.json({ error: "forbidden" }, 403);
      await createDb(c.env.DB).delete(connectors).where(eq(connectors.id, row.id));
      return c.body(null, 204);
    })
    .post("/:connectorId/check", async (c) => {
      const s = await scope(c);
      if (!s) return c.json({ error: "not_found" }, 404);
      const row = await findConnector(c.env, s.owner, c.req.param("connectorId"));
      if (!row) return c.json({ error: "not_found" }, 404);
      const next = { ...row, ...(await checkConnector(c.env, row)), updatedAt: new Date() };
      await createDb(c.env.DB)
        .update(connectors)
        .set({ status: next.status, lastError: next.lastError, tools: next.tools, updatedAt: next.updatedAt })
        .where(and(eq(connectors.id, row.id), ownerWhere(s.owner)));
      return c.json({ connector: toConnector(next, s.canEdit) });
    })
    /** Sign in (again) to an OAuth connector: the link to open in the browser. */
    .post("/:connectorId/authorize", async (c) => {
      const s = await scope(c);
      if (!s) return c.json({ error: "not_found" }, 404);
      const row = await findConnector(c.env, s.owner, c.req.param("connectorId"));
      if (!row || row.auth !== "oauth") return c.json({ error: "not_found" }, 404);
      if (!s.canEdit) return c.json({ error: "forbidden" }, 403);
      try {
        return c.json({ authorizeUrl: await startAuthorization(c.env, row, publicOrigin(c), c.get("user").id) });
      } catch (err) {
        return c.json({ error: "sign_in_failed", message: err instanceof Error ? err.message : String(err) }, 502);
      }
    });
}

/** This server's public address, for the sign-in to come back to. */
export function publicOrigin(c: Context<AppEnv>): string {
  return c.env.BETTER_AUTH_URL?.replace(/\/$/, "") || new URL(c.req.url).origin;
}

/**
 * Mounted at /api/connectors/oauth: where a connector's sign-in comes back to. The state names the
 * sign-in Myrel started; it finishes only for the person who started it. A browser signed in to
 * Myrel as them finishes at once; one signed in as someone else is refused; one not signed in (the
 * desktop and mobile apps open the system browser) is asked to confirm whose connector it is.
 * Ends on the settings page with the result.
 */
export const connectorOAuthRoutes = new Hono<AppEnv>()
  .get("/callback", async (c) => {
    const { code, state, error } = c.req.query();
    return arrive(c, { code, state, error });
  })
  // The confirmation page's button, or a server that posts its answer (response_mode=form_post),
  // which is checked like the GET.
  .post("/callback", async (c) => {
    const form = await c.req.parseBody();
    const params = { code: String(form.code ?? ""), state: String(form.state ?? ""), error: form.error ? String(form.error) : undefined };
    if (form.confirmed !== "1") return arrive(c, params);
    const started = await pendingSignIn(c.env, params.state);
    const session = started?.by ? await createAuth(c.env).api.getSession({ headers: c.req.raw.headers }) : null;
    if (session && session.user.id !== started?.by) {
      return finish(c, { state: params.state, error: "This sign-in was started from another Myrel account." });
    }
    return finish(c, params);
  });

/** A sign-in came back: finish it for the person who started it, or ask a browser without a session to confirm. */
async function arrive(c: Context<AppEnv>, { code, state, error }: { code?: string; state?: string; error?: string }) {
  const started = await pendingSignIn(c.env, state);
  if (started?.by && code && !error) {
    const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
    if (session && session.user.id !== started.by) {
      return finish(c, { state, error: "This sign-in was started from another Myrel account." });
    }
    if (!session) return confirmPage(c, { code, state: state!, connectorId: started.id, by: started.by });
  }
  return finish(c, { code, state, error });
}

async function finish(c: Context<AppEnv>, params: { code?: string; state?: string; error?: string }) {
  const result = await finishAuthorization(c.env, params);
  const [row] = result.id ? await createDb(c.env.DB).select().from(connectors).where(eq(connectors.id, result.id)) : [];
  if (result.ok) {
    if (row) {
      const checked = await checkConnector(c.env, row);
      await createDb(c.env.DB).update(connectors).set(checked).where(eq(connectors.id, row.id));
    }
  }
  const back = new URL("/settings", publicOrigin(c));
  back.searchParams.set("section", "connectors");
  if (result.id) back.searchParams.set("connector", result.id);
  // A project's connector comes back to that project's settings.
  if (row?.projectId) back.searchParams.set("project", row.projectId);
  back.searchParams.set("result", result.ok ? "ok" : "error");
  return c.redirect(back.toString(), 302);
}

/** Asks the person to confirm the connector and the Myrel account the sign-in will go to. */
async function confirmPage(c: Context<AppEnv>, p: { code: string; state: string; connectorId: string; by: string }) {
  const db = createDb(c.env.DB);
  const [row] = await db.select({ name: connectors.name }).from(connectors).where(eq(connectors.id, p.connectorId));
  const [owner] = await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, p.by));
  const name = esc(row?.name ?? "connector");
  const email = esc(owner?.email ?? "unknown");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Myrel</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 16px;color:#18181b">
<h1 style="font-size:20px">Finish connecting ${name}?</h1>
<p style="line-height:1.5">This sign-in goes to the Myrel account <b>${email}</b>. Its agents will act with the account you just signed in with.
Continue only if <b>${email}</b> is you and you started this from Myrel.</p>
<p style="line-height:1.5;color:#52525b">Bu oturum <b>${email}</b> Myrel hesabına bağlanacak. Bu hesap senin değilse ve bağlantıyı Myrel'den sen başlatmadıysan devam etme.</p>
<form method="post"><input type="hidden" name="confirmed" value="1"><input type="hidden" name="code" value="${esc(p.code)}"><input type="hidden" name="state" value="${esc(p.state)}">
<button type="submit" style="background:#5b6cff;color:#fff;border:0;padding:10px 16px;border-radius:8px;font-size:15px">Connect · Bağla</button></form>
</body></html>`;
  return c.html(html, 200, { "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", "referrer-policy": "no-referrer" });
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Mounted at /api/account/connectors: the signed-in person's own connectors. */
export const accountConnectorRoutes = connectorRoutes(async (c) => ({ owner: { userId: c.get("user").id }, canEdit: true }));

/** Mounted at /api/projects/:id/connectors. Members see them; owners and admins change them. */
export const projectConnectorRoutes = connectorRoutes(async (c) => {
  const projectId = c.req.param("id")!;
  const project = await findMembership(c.env, projectId, c.get("user").id);
  if (!project) return null;
  return { owner: { projectId }, canEdit: project.role === "owner" || project.role === "admin" };
});

/** Mounted at /api/connectors/catalog: search the connector catalog (a copy of the official MCP Registry). */
export const connectorCatalogRoutes = new Hono<AppEnv>().use(requireUser).get("/", async (c) => {
  const { q, offset, category } = c.req.query();
  const parsed = CatalogCategory.safeParse(category);
  return c.json(await searchCatalog(c.env, { q, offset: Number(offset) || 0, category: parsed.success ? parsed.data : undefined }));
});

function originOf(url: string | null | undefined): string | null {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}
