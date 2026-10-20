import { createDb, schema } from "@myrel/db";
import { createId, CreateConnectorInput, UpdateConnectorInput } from "@myrel/protocol";
import { and, asc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { blockedUrl } from "../connectors/client";
import { finishAuthorization, startAuthorization } from "../connectors/oauth";
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
          const authorizeUrl = await startAuthorization(c.env, row, publicOrigin(c));
          return c.json({ connector: toConnector(row, true), authorizeUrl }, 201);
        } catch (err) {
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
        return c.json({ authorizeUrl: await startAuthorization(c.env, row, publicOrigin(c)) });
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
 * Mounted at /api/connectors/oauth: where a connector's sign-in comes back to. No session needed:
 * the state names the sign-in Myrel started. Ends on the settings page with the result.
 */
export const connectorOAuthRoutes = new Hono<AppEnv>().get("/callback", async (c) => {
  const { code, state, error } = c.req.query();
  const result = await finishAuthorization(c.env, { code, state, error });
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
});

/** Mounted at /api/account/connectors: the signed-in person's own connectors. */
export const accountConnectorRoutes = connectorRoutes(async (c) => ({ owner: { userId: c.get("user").id }, canEdit: true }));

/** Mounted at /api/projects/:id/connectors. Members see them; owners and admins change them. */
export const projectConnectorRoutes = connectorRoutes(async (c) => {
  const projectId = c.req.param("id")!;
  const project = await findMembership(c.env, projectId, c.get("user").id);
  if (!project) return null;
  return { owner: { projectId }, canEdit: project.role === "owner" || project.role === "admin" };
});
