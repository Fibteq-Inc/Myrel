import { createDb, schema } from "@altair/db";
import { CreateProjectInput, createId, type Project } from "@altair/protocol";
import { getAgentByName } from "agents";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { USER_ID_HEADER } from "../agents/project-agent";
import { type AppEnv, requireUser } from "../middleware";

const { projects, projectMembers } = schema;

export const projectRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .get("/", async (c) => {
    const rows = await createDb(c.env.DB)
      .select({ id: projects.id, name: projects.name, role: projectMembers.role, createdAt: projects.createdAt })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(eq(projectMembers.userId, c.get("user").id))
      .orderBy(desc(projects.createdAt));
    return c.json({ projects: rows.map(toProject) });
  })
  .post("/", async (c) => {
    const input = CreateProjectInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);

    const userId = c.get("user").id;
    const id = createId("project");
    const createdAt = new Date();
    const db = createDb(c.env.DB);
    await db.batch([
      db.insert(projects).values({ id, name: input.data.name, createdBy: userId, createdAt, updatedAt: createdAt }),
      db.insert(projectMembers).values({ projectId: id, userId, role: "owner", createdAt }),
    ]);
    return c.json({ project: toProject({ id, name: input.data.name, role: "owner", createdAt }) }, 201);
  })
  .get("/:id", async (c) => {
    const project = await findMembership(c.env, c.req.param("id"), c.get("user").id);
    return project ? c.json({ project }) : c.json({ error: "not_found" }, 404);
  })
  .get("/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!(await findMembership(c.env, id, c.get("user").id))) return c.json({ error: "not_found" }, 404);
    const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0);
    const agent = await getAgentByName(c.env.PROJECT_AGENT, id);
    return c.json(await agent.getMessagesAfter(after));
  })
  .get("/:id/ws", async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: "expected_websocket" }, 426);
    }
    const id = c.req.param("id");
    const user = c.get("user");
    if (!(await findMembership(c.env, id, user.id))) return c.json({ error: "not_found" }, 404);

    // The DO trusts this header; it is always overwritten here, never taken from the client.
    const headers = new Headers(c.req.raw.headers);
    headers.set(USER_ID_HEADER, user.id);
    const agent = await getAgentByName(c.env.PROJECT_AGENT, id);
    return agent.fetch(new Request(c.req.raw, { headers }));
  });

async function findMembership(env: Env, projectId: string, userId: string): Promise<Project | null> {
  const [row] = await createDb(env.DB)
    .select({ id: projects.id, name: projects.name, role: projectMembers.role, createdAt: projects.createdAt })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return row ? toProject(row) : null;
}

function toProject(row: { id: string; name: string; role: Project["role"]; createdAt: Date }): Project {
  return { ...row, createdAt: row.createdAt.toISOString() };
}
