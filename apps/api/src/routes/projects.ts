import { createDb, schema } from "@myrel/db";
import {
  AddProjectRepoInput,
  CreateInviteInput,
  CreateProjectInput,
  createId,
  type Invite,
  type Member,
  type Project,
  type ProjectCost,
  type ProjectRole,
  type ProjectSettings,
  UpdateMemberInput,
  MAX_WORKSPACE_FOLDERS,
  SetWorkspaceInput,
  WorkspaceFolderInput,
  TaskTarget,
  UpdateProjectSettingsInput,
} from "@myrel/protocol";
import { getAgentByName } from "agents";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { SESSION_HEADER, USER_ID_HEADER } from "../agents/project-agent";
import { GithubError, githubConfigured, installationToken } from "../github/app";
import { listPullRequests } from "../github/pulls";
import { canUseInstallation, listProjectRepos } from "../github/store";
import { type AppEnv, requireUser } from "../middleware";
import { canCreateProject } from "../extensions";
import { deleteProject } from "../projects/delete";
import { getWorkspace, notifyProject, parseFolders, parseInfo, setWorkspaceFolder } from "../runners";

const { apiKeys, projects, projectInvites, projectMembers, projectRepos, projectWorkspaces, runners, user } = schema;

const projectColumns = {
  id: projects.id,
  name: projects.name,
  role: projectMembers.role,
  createdAt: projects.createdAt,
  activeCount: projects.activeCount,
  waitingCount: projects.waitingCount,
};

export const projectRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .get("/", async (c) => {
    const userId = c.get("user").id;
    const [rows, costs] = await Promise.all([
      createDb(c.env.DB)
        .select(projectColumns)
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .where(eq(projectMembers.userId, userId))
        .orderBy(desc(projects.createdAt)),
      projectCosts(c.env.DB, userId),
    ]);
    return c.json({ projects: rows.map((row) => ({ ...toProject(row), cost: costs.get(row.id) ?? emptyCost })) });
  })
  .post("/", async (c) => {
    const input = CreateProjectInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);

    const userId = c.get("user").id;
    const allowed = await canCreateProject(c.env, userId);
    if (!allowed.ok) return c.json({ error: "limit_reached", message: allowed.reason }, 402);
    const id = createId("project");
    const createdAt = new Date();
    const db = createDb(c.env.DB);
    await db.batch([
      db.insert(projects).values({ id, name: input.data.name, createdBy: userId, createdAt, updatedAt: createdAt }),
      db.insert(projectMembers).values({ projectId: id, userId, role: "owner", createdAt }),
    ]);
    return c.json({ project: toProject({ id, name: input.data.name, role: "owner", createdAt, activeCount: 0, waitingCount: 0 }) }, 201);
  })
  .get("/:id", async (c) => {
    const project = await findMembership(c.env, c.req.param("id"), c.get("user").id);
    return project ? c.json({ project }) : c.json({ error: "not_found" }, 404);
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const project = await findMembership(c.env, id, c.get("user").id);
    if (!project) return c.json({ error: "not_found" }, 404);
    if (project.role !== "owner") return c.json({ error: "forbidden", message: "Only owners can delete a project." }, 403);
    await deleteProject(c.env, id);
    return c.body(null, 204);
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
    const { name, model, taskTarget } = input.data;
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
        ...(taskTarget !== undefined && { taskTarget }),
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
    // An open connection was let in as a member: it ends with the membership.
    await (await getAgentByName(c.env.PROJECT_AGENT, id)).disconnectUser(userId);
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
  .get("/:id/repos", async (c) => {
    const id = c.req.param("id");
    if (!(await findMembership(c.env, id, c.get("user").id))) return c.json({ error: "not_found" }, 404);
    return c.json({ repos: await listProjectRepos(c.env.DB, id) });
  })
  .post("/:id/repos", async (c) => {
    const id = c.req.param("id");
    const userId = c.get("user").id;
    const project = await findMembership(c.env, id, userId);
    if (!project) return c.json({ error: "not_found" }, 404);
    if (!canManage(project.role)) return c.json({ error: "forbidden" }, 403);
    if (!githubConfigured(c.env)) return c.json({ error: "github_not_configured" }, 503);
    const input = AddProjectRepoInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    const { installationId, repoId } = input.data;
    const grant = await canUseInstallation(c.env.DB, userId, installationId);
    if (grant === "no") return c.json({ error: "forbidden" }, 403);
    if (grant === "stale") return c.json({ error: "github_reauth", message: "Sign in to GitHub again to pick repositories." }, 409);

    // Narrowing a token to the repo fails unless the installation really covers it.
    let repo;
    try {
      const res = await installationToken(c.env, installationId, {
        repositoryIds: [repoId],
        permissions: { metadata: "read" },
      });
      repo = res.repositories?.find((r) => r.id === repoId);
    } catch (err) {
      if (!(err instanceof GithubError) || err.status >= 500) throw err;
    }
    if (!repo) return c.json({ error: "repo_not_accessible" }, 404);

    await createDb(c.env.DB)
      .insert(projectRepos)
      .values({
        projectId: id,
        repoId,
        installationId,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
        private: repo.private,
        addedBy: userId,
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [projectRepos.projectId, projectRepos.repoId],
        set: { installationId, fullName: repo.full_name, defaultBranch: repo.default_branch, private: repo.private },
      });
    const repos = await listProjectRepos(c.env.DB, id);
    return c.json({ repo: repos.find((r) => r.repoId === repoId) }, 201);
  })
  .delete("/:id/repos/:repoId", async (c) => {
    const id = c.req.param("id");
    const project = await findMembership(c.env, id, c.get("user").id);
    if (!project) return c.json({ error: "not_found" }, 404);
    if (!canManage(project.role)) return c.json({ error: "forbidden" }, 403);
    await createDb(c.env.DB)
      .delete(projectRepos)
      .where(and(eq(projectRepos.projectId, id), eq(projectRepos.repoId, Number(c.req.param("repoId")))));
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
  // Pull requests the thread's tasks opened, with their live state.
  .get("/:id/threads/:threadId/pull-requests", async (c) => {
    const thread = await findThread(c.env, c.req.param("id"), c.req.param("threadId"), c.get("user").id);
    if (!thread) return c.json({ error: "not_found" }, 404);
    return c.json({ pullRequests: await listPullRequests(c.env.DB, c.req.param("id"), thread) });
  })
  // What the thread's cloud tasks saved (its Artifacts workspace): history and one folder or file.
  .get("/:id/threads/:threadId/files", async (c) => {
    const thread = await findThread(c.env, c.req.param("id"), c.req.param("threadId"), c.get("user").id);
    if (!thread) return c.json({ error: "not_found" }, 404);
    const agent = await getAgentByName(c.env.THREAD_AGENT, thread);
    return c.json({ workspace: await agent.readWorkspace(c.req.query("path") ?? "", c.req.query("ref") || undefined) });
  })
  .post("/:id/threads/:threadId/tasks/:taskId/cancel", async (c) => {
    const thread = await findThread(c.env, c.req.param("id"), c.req.param("threadId"), c.get("user").id);
    if (!thread) return c.json({ error: "not_found" }, 404);
    const agent = await getAgentByName(c.env.THREAD_AGENT, thread);
    const cancelled = await agent.cancelTask(c.req.param("taskId"));
    return cancelled.ok ? c.json({ ok: true }) : c.json({ error: "cannot_cancel", message: cancelled.error }, 409);
  })
  // The local folder this project works in, on one of the user's computers.
  .get("/:id/workspace", async (c) => {
    const id = c.req.param("id");
    if (!(await findMembership(c.env, id, c.get("user").id))) return c.json({ error: "not_found" }, 404);
    return c.json({ workspace: await getWorkspace(c.env, id) });
  })
  .put("/:id/workspace", async (c) => {
    const id = c.req.param("id");
    const userId = c.get("user").id;
    const project = await findMembership(c.env, id, userId);
    if (!project) return c.json({ error: "not_found" }, 404);
    if (!canManage(project.role)) return c.json({ error: "forbidden", message: "Only project owners and admins can do this." }, 403);
    const input = SetWorkspaceInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);

    // Only your own computers, and only a folder you shared on it with `myrel-runner share`.
    const db = createDb(c.env.DB);
    const [runner] = await db
      .select()
      .from(runners)
      .where(and(eq(runners.id, input.data.runnerId), eq(runners.userId, userId)));
    if (!runner) return c.json({ error: "invalid_input", message: "Unknown computer." }, 400);
    const info = parseInfo(runner.info);
    if (!info?.folders.some((f) => f.path === input.data.path)) {
      return c.json({ error: "invalid_input", message: "That folder is not shared on this computer." }, 400);
    }

    const now = new Date();
    const values = { ...input.data, updatedAt: now };
    // The other folders belong to the computer: they stay only while the project stays on it.
    const [before] = await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.projectId, id));
    const kept = before?.runnerId === input.data.runnerId ? parseFolders(before.folders).filter((f) => f !== input.data.path) : [];
    await db
      .insert(projectWorkspaces)
      .values({ projectId: id, createdBy: userId, createdAt: now, ...values, folders: JSON.stringify(kept) })
      .onConflictDoUpdate({ target: projectWorkspaces.projectId, set: { ...values, folders: JSON.stringify(kept), createdBy: userId } });
    await notifyProject(c.env, id);
    return c.json({ workspace: await getWorkspace(c.env, id) });
  })
  // Other folders on the same computer the project's agent may work in, besides its main folder.
  .post("/:id/workspace/folders", async (c) => {
    const id = c.req.param("id");
    const project = await findMembership(c.env, id, c.get("user").id);
    if (!project) return c.json({ error: "not_found" }, 404);
    if (!canManage(project.role)) return c.json({ error: "forbidden", message: "Only project owners and admins can do this." }, 403);
    const input = WorkspaceFolderInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    const workspace = await getWorkspace(c.env, id);
    if (!workspace) return c.json({ error: "invalid_input", message: "Connect a local folder to this project first." }, 400);
    if (workspace.folders.length >= MAX_WORKSPACE_FOLDERS) {
      return c.json({ error: "invalid_input", message: `A project can have at most ${MAX_WORKSPACE_FOLDERS} other folders.` }, 400);
    }
    // Like the main folder, only one shared on that computer (the folder picker shares it first), and
    // only by the computer's owner: its other shared folders may belong to their other projects.
    const [runner] = await createDb(c.env.DB).select().from(runners).where(eq(runners.id, workspace.runnerId));
    if (runner?.userId !== c.get("user").id) {
      return c.json({ error: "forbidden", message: "Only the person whose computer this is can add its folders." }, 403);
    }
    if (!parseInfo(runner?.info ?? null)?.folders.some((f) => f.path === input.data.path)) {
      return c.json({ error: "invalid_input", message: "That folder is not shared on this computer." }, 400);
    }
    await setWorkspaceFolder(c.env, id, input.data.path, true);
    return c.json({ workspace: await getWorkspace(c.env, id) });
  })
  .delete("/:id/workspace/folders", async (c) => {
    const id = c.req.param("id");
    const project = await findMembership(c.env, id, c.get("user").id);
    if (!project) return c.json({ error: "not_found" }, 404);
    if (!canManage(project.role)) return c.json({ error: "forbidden", message: "Only project owners and admins can do this." }, 403);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "invalid_input", message: "Which folder?" }, 400);
    await setWorkspaceFolder(c.env, id, path, false);
    return c.json({ workspace: await getWorkspace(c.env, id) });
  })
  .delete("/:id/workspace", async (c) => {
    const id = c.req.param("id");
    const project = await findMembership(c.env, id, c.get("user").id);
    if (!project) return c.json({ error: "not_found" }, 404);
    if (!canManage(project.role)) return c.json({ error: "forbidden", message: "Only project owners and admins can do this." }, 403);
    await createDb(c.env.DB).delete(projectWorkspaces).where(eq(projectWorkspaces.projectId, id));
    await notifyProject(c.env, id);
    return c.json({ workspace: null });
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
    const session = c.get("session");
    headers.set(SESSION_HEADER, `${session.id}:${session.expiresAt}`);
    const agent = await getAgentByName(c.env.PROJECT_AGENT, id);
    return agent.fetch(new Request(c.req.raw, { headers }));
  });

export async function findMembership(env: Env, projectId: string, userId: string): Promise<Project | null> {
  const [row] = await createDb(env.DB)
    .select(projectColumns)
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

function toProject(row: {
  id: string;
  name: string;
  role: Project["role"];
  createdAt: Date;
  activeCount: number;
  waitingCount: number;
}): Project {
  const { activeCount, waitingCount, ...rest } = row;
  return { ...rest, createdAt: row.createdAt.toISOString(), activity: { working: activeCount, waiting: waitingCount } };
}

const emptyCost: ProjectCost = { monthMicros: 0, totalMicros: 0 };

/** This month's and all-time model cost of every project the user is in, keyed by project. */
async function projectCosts(d1: D1Database, userId: string) {
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const { results } = await d1
    .prepare(
      `SELECT project_id AS projectId,
         COALESCE(SUM(CASE WHEN created_at >= ?2 THEN cost_micros END), 0) AS monthMicros,
         COALESCE(SUM(cost_micros), 0) AS totalMicros
       FROM usage_events
       WHERE project_id IN (SELECT project_id FROM project_members WHERE user_id = ?1)
       GROUP BY project_id`,
    )
    .bind(userId, monthStart)
    .all<{ projectId: string; monthMicros: number; totalMicros: number }>();
  return new Map(
    results.map((r) => [r.projectId, { monthMicros: Number(r.monthMicros), totalMicros: Number(r.totalMicros) }]),
  );
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
    .select({
      name: projects.name,
      provider: projects.llmProvider,
      model: projects.llmModel,
      keyId: projects.llmKeyId,
      taskTarget: projects.taskTarget,
    })
    .from(projects)
    .where(eq(projects.id, projectId));
  return {
    ...row!,
    provider: row!.provider as ProjectSettings["provider"],
    taskTarget: TaskTarget.catch("auto").parse(row!.taskTarget),
  };
}
