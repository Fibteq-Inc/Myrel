import { createDb, schema } from "@myrel/db";
import { SetPersonalInProjectInput } from "@myrel/protocol";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { presentConnectors } from "../connectors/store";
import { type AppEnv, requireUser } from "../middleware";
import { toSkill } from "../skills/store";
import { findMembership } from "./projects";

const { connectors, projectConnectors, projectSkills, skills } = schema;

/**
 * Mounted at /api/projects/:id/personal: the caller's own skills and connectors, and which of
 * them are on in this project. Personal ones start off in every project; any member turns their
 * own on or off here.
 */
export const personalInProjectRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .get("/", async (c) => {
    const projectId = c.req.param("id")!;
    const userId = c.get("user").id;
    if (!(await findMembership(c.env, projectId, userId))) return c.json({ error: "not_found" }, 404);
    const db = createDb(c.env.DB);
    const [mySkills, myConnectors, skillLinks, connectorLinks] = await Promise.all([
      db.select().from(skills).where(eq(skills.ownerId, userId)).orderBy(asc(skills.name)),
      db.select().from(connectors).where(eq(connectors.ownerId, userId)).orderBy(asc(connectors.createdAt)),
      db.select({ id: projectSkills.skillId }).from(projectSkills).where(eq(projectSkills.projectId, projectId)),
      db.select({ id: projectConnectors.connectorId }).from(projectConnectors).where(eq(projectConnectors.projectId, projectId)),
    ]);
    const onSkills = new Set(skillLinks.map((r) => r.id));
    const onConnectors = new Set(connectorLinks.map((r) => r.id));
    const shown = await presentConnectors(c.env, myConnectors, true);
    return c.json({
      skills: mySkills.map((r) => ({ ...toSkill(r, true), inProject: onSkills.has(r.id) })),
      connectors: shown.map((r) => ({ ...r, inProject: onConnectors.has(r.id) })),
    });
  })
  /** Turns one of the caller's own skills or connectors on or off in this project. */
  .put("/:kind/:itemId", async (c) => {
    const projectId = c.req.param("id")!;
    const userId = c.get("user").id;
    const kind = c.req.param("kind");
    if (kind !== "skills" && kind !== "connectors") return c.json({ error: "not_found" }, 404);
    if (!(await findMembership(c.env, projectId, userId))) return c.json({ error: "not_found" }, 404);
    const input = SetPersonalInProjectInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    const db = createDb(c.env.DB);
    const itemId = c.req.param("itemId");
    const table = kind === "skills" ? skills : connectors;
    const [own] = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, itemId), eq(table.ownerId, userId)));
    if (!own) return c.json({ error: "not_found" }, 404);
    if (kind === "skills") {
      await (input.data.on
        ? db.insert(projectSkills).values({ projectId, skillId: itemId }).onConflictDoNothing()
        : db.delete(projectSkills).where(and(eq(projectSkills.projectId, projectId), eq(projectSkills.skillId, itemId))));
    } else {
      await (input.data.on
        ? db.insert(projectConnectors).values({ projectId, connectorId: itemId }).onConflictDoNothing()
        : db.delete(projectConnectors).where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.connectorId, itemId))));
    }
    return c.json({ on: input.data.on });
  });
