import { createDb, schema } from "@altair/db";
import {
  CreateInviteInput,
  CreateProjectInput,
  createId,
  type Invite,
  type Member,
  type Project,
  type ProjectRole,
  type ProjectSettings,
  UpdateMemberInput,
  UpdateProjectSettingsInput,
} from "@altair/protocol";
import { getAgentByName } from "agents";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { USER_ID_HEADER } from "../agents/project-agent";
import { type AppEnv, requireUser } from "../middleware";

const { apiKeys, projects, projectInvites, projectMembers, user } = schema;

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
  .get("/:id/settings", async (c) => {
    const id = c.req.param("id");
    if (!(await findMembership(c.env, id, c.get("user").id))) return c.json({ error: "not_found" }, 404);
    return c.json({ settings: await readSettings(c.env, id) });
  })
  .patch("/:id/settings", async (c) => {
    const id = c.req.param("id");
    const me = c.get("user");
    const project = await findMembership(c.env, id, me.id);
    if (!project) return c.json({ error: "not_found" }, 404);
    if (!canManage(project.role)) return c.json({ error: "forbidden" }, 403);
    const input = UpdateProjectSettingsInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);

    const db = createDb(c.env.DB);
    const current = await readSettings(c.env, id);
    const { name, model } = input.data;
    let { provider = current.provider, keyId = current.keyId } = input.data;
    if (input.data.keyId) {
      // Only your own keys or the server's shared ones can be attached to a project.
      const [key] = await db
        .select({ provider: apiKeys.provider })
        .from(apiKeys)
        .where(and(eq(apiKeys.id, input.data.keyId), or(eq(apiKeys.ownerId, me.id), isNull(apiKeys.ownerId))));
      if (!key) return c.json({ error: "invalid_input", message: "Unknown key." }, 400);
      provider = key.provider as ProjectSettings["provider"];
    } else if (input.data.keyId === undefined && input.data.provider !== undefined && provider !== current.provider) {
      keyId = null; // the old key belongs to the old provider
    }
    await db
      .update(projects)
      .set({
        ...(name !== undefined && { name }),
        ...(model !== undefined && { llmModel: model || null }),
        llmProvider: provider,
        llmKeyId: keyId,
      })
      .where(eq(projects.id, id));
    return c.json({ settings: await readSettings(c.env, id) });
  })

  // ---- Members ----

  .get("/:id/members", async (c) => {
    const id = c.req.param("id");
    const project = await findMembership(c.env, id, c.get("user").id);
    if (!project) return c.json({ error: "not_found" }, 404);
    const rows = await createDb(c.env.DB)
      .select({ id: user.id, name: user.name, email: user.email, role: projectMembers.role })
      .from(projectMembers)
      .innerJoin(user, eq(user.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, id))
      .orderBy(projectMembers.createdAt);
    const members: Member[] = rows.map(({ email, ...m }) => (canManage(project.role) ? { ...m, email } : m));
    return c.json({ members });
  })
  .patch("/:id/members/:userId", async (c) => {
    const { id, userId } = c.req.param();
    const project = await findMembership(c.env, id, c.get("user").id);
    if (!project) return c.json({ error: "not_found" }, 404);
    const input = UpdateMemberInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    const target = await memberRole(c.env, id, userId);
    if (!target) return c.json({ error: "not_found" }, 404);

    // Admins manage admins and members; only owners grant or take away ownership.
    const touchesOwner = target === "owner" || input.data.role === "owner";
    if (!canManage(project.role) || (touchesOwner && project.role !== "owner")) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (target === "owner" && input.data.role !== "owner" && (await ownerCount(c.env, id)) <= 1) {
      return c.json({ error: "last_owner", message: "A project needs at least one owner." }, 409);
    }
    await createDb(c.env.DB)
      .update(projectMembers)
      .set({ role: input.data.role })
      .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, userId)));
    return c.json({ ok: true });
  })
  .delete("/:id/members/:userId", async (c) => {
    const { id, userId } = c.req.param();
    const me = c.get("user");
    const project = await findMembership(c.env, id, me.id);
    if (!project) return c.json({ error: "not_found" }, 404);
    const target = await memberRole(c.env, id, userId);
    if (!target) return c.json({ error: "not_found" }, 404);

    // Anyone may leave; removing others takes an admin, and removing an owner takes an owner.
    const leaving = userId === me.id;
    if (!leaving && (!canManage(project.role) || (target === "owner" && project.role !== "owner"))) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (target === "owner" && (await ownerCount(c.env, id)) <= 1) {
      return c.json({ error: "last_owner", message: "A project needs at least one owner." }, 409);
    }
    await createDb(c.env.DB)
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, id), eq(projectMembers.userId, userId)));
    return c.body(null, 204);
  })

  // ---- Invitations ----

  .get("/:id/invites", async (c) => {
    const id = c.req.param("id");
    const project = await findMembership(c.env, id, c.get("user").id);
    if (!project) return c.json({ error: "not_found" }, 404);
    if (!canManage(project.role)) return c.json({ error: "forbidden" }, 403);
    const rows = await createDb(c.env.DB)
      .select({
        id: projectInvites.id,
        projectId: projectInvites.projectId,
        email: projectInvites.email,
        role: projectInvites.role,
        invitedBy: user.name,
        createdAt: projectInvites.createdAt,
      })
      .from(projectInvites)
      .innerJoin(user, eq(user.id, projectInvites.invitedBy))
      .where(eq(projectInvites.projectId, id))
      .orderBy(desc(projectInvites.createdAt));
    const invites: Invite[] = rows.map((r) => ({ ...r, projectName: project.name, createdAt: r.createdAt.toISOString() }));
    return c.json({ invites });
  })
  .post("/:id/invites", async (c) => {
    const id = c.req.param("id");
    const me = c.get("user");
    const project = await findMembership(c.env, id, me.id);
    if (!project) return c.json({ error: "not_found" }, 404);
    if (!canManage(project.role)) return c.json({ error: "forbidden" }, 403);
    const input = CreateInviteInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    const { email, role } = input.data;

    const db = createDb(c.env.DB);
    const [existing] = await db
      .select({ id: user.id })
      .from(projectMembers)
      .innerJoin(user, eq(user.id, projectMembers.userId))
      .where(and(eq(projectMembers.projectId, id), sql`lower(${user.email}) = ${email}`));
    if (existing) return c.json({ error: "already_member", message: "This person is already in the project." }, 409);

    const invite = { id: createId("invite"), projectId: id, email, role, invitedBy: me.id, createdAt: new Date() };
    await db
      .insert(projectInvites)
      .values(invite)
      .onConflictDoUpdate({ target: [projectInvites.projectId, projectInvites.email], set: { role, invitedBy: me.id } });
    const [saved] = await db
      .select({ id: projectInvites.id, createdAt: projectInvites.createdAt })
      .from(projectInvites)
      .where(and(eq(projectInvites.projectId, id), eq(projectInvites.email, email)));
    return c.json(
      {
        invite: {
          ...invite,
          id: saved!.id,
          projectName: project.name,
          invitedBy: me.name,
          createdAt: saved!.createdAt.toISOString(),
        } satisfies Invite,
      },
      201,
    );
  })
  .delete("/:id/invites/:inviteId", async (c) => {
    const { id, inviteId } = c.req.param();
    const project = await findMembership(c.env, id, c.get("user").id);
    if (!project) return c.json({ error: "not_found" }, 404);
    if (!canManage(project.role)) return c.json({ error: "forbidden" }, 403);
    await createDb(c.env.DB)
      .delete(projectInvites)
      .where(and(eq(projectInvites.id, inviteId), eq(projectInvites.projectId, id)));
    return c.body(null, 204);
  })
  .get("/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!(await findMembership(c.env, id, c.get("user").id))) return c.json({ error: "not_found" }, 404);
    const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0);
    const agent = await getAgentByName(c.env.PROJECT_AGENT, id);
    return c.json(await agent.getMessagesAfter(after));
  })
  .get("/:id/threads/:threadId/tasks", async (c) => {
    const thread = await findThread(c.env, c.req.param("id"), c.req.param("threadId"), c.get("user").id);
    if (!thread) return c.json({ error: "not_found" }, 404);
    const agent = await getAgentByName(c.env.THREAD_AGENT, thread);
    return c.json({ tasks: await agent.getTasks() });
  })
  .post("/:id/threads/:threadId/tasks/:taskId/cancel", async (c) => {
    const thread = await findThread(c.env, c.req.param("id"), c.req.param("threadId"), c.get("user").id);
    if (!thread) return c.json({ error: "not_found" }, 404);
    const agent = await getAgentByName(c.env.THREAD_AGENT, thread);
    const cancelled = await agent.cancelTask(c.req.param("taskId"));
    return cancelled ? c.json({ ok: true }) : c.json({ error: "not_running" }, 409);
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

/** The thread's id when it exists in a project the user belongs to. */
async function findThread(env: Env, projectId: string, threadId: string, userId: string): Promise<string | null> {
  if (!(await findMembership(env, projectId, userId))) return null;
  const project = await getAgentByName(env.PROJECT_AGENT, projectId);
  return (await project.getThread(threadId)) ? threadId : null;
}

function toProject(row: { id: string; name: string; role: Project["role"]; createdAt: Date }): Project {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function canManage(role: ProjectRole) {
  return role === "owner" || role === "admin";
}

async function memberRole(env: Env, projectId: string, userId: string): Promise<ProjectRole | null> {
  const [row] = await createDb(env.DB)
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return row?.role ?? null;
}

async function ownerCount(env: Env, projectId: string): Promise<number> {
  const rows = await createDb(env.DB)
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, "owner")));
  return rows.length;
}

async function readSettings(env: Env, projectId: string): Promise<ProjectSettings> {
  const [row] = await createDb(env.DB)
    .select({ name: projects.name, provider: projects.llmProvider, model: projects.llmModel, keyId: projects.llmKeyId })
    .from(projects)
    .where(eq(projects.id, projectId));
  return { ...row!, provider: row!.provider as ProjectSettings["provider"] };
}
