import { createDb, schema } from "@altair/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { deleteProject } from "./projects/delete";

const { projectMembers, projects, usageEvents, user } = schema;

const SUCCESSION = { owner: 0, admin: 1, member: 2 } as const;

/**
 * Deletes a person's account, as the app stores require. Projects they own alone go with it
 * (through deleteProject, so files, artifacts and agents are wiped too); a shared project passes
 * to its next owner, else its oldest admin, else its oldest member. Their sessions, keys,
 * runners, memberships, notifications and push devices cascade from the user row. Usage rows
 * stay as the billing ledger but lose the person's id. A last server admin hands the role to the
 * oldest remaining account, so the server is never left without one.
 */
export async function deleteAccount(env: Env, userId: string): Promise<void> {
  const db = createDb(env.DB);
  const mine = await db
    .select({ projectId: projectMembers.projectId, role: projectMembers.role })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId));

  for (const { projectId, role } of mine) {
    const others = await db
      .select({ userId: projectMembers.userId, role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), ne(projectMembers.userId, userId)))
      .orderBy(asc(projectMembers.createdAt));
    if (role === "owner" && !others.some((m) => m.role === "owner")) {
      if (others.length === 0) {
        await deleteProject(env, projectId);
        continue;
      }
      const heir = [...others].sort((a, b) => SUCCESSION[a.role] - SUCCESSION[b.role])[0]!;
      await db
        .update(projectMembers)
        .set({ role: "owner" })
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, heir.userId)));
    }
  }

  // projects.created_by has no cascade: point the ones this person started at a current owner.
  const started = await db.select({ id: projects.id }).from(projects).where(eq(projects.createdBy, userId));
  for (const { id } of started) {
    const [owner] = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, id), eq(projectMembers.role, "owner"), ne(projectMembers.userId, userId)))
      .orderBy(asc(projectMembers.createdAt))
      .limit(1);
    if (owner) await db.update(projects).set({ createdBy: owner.userId }).where(eq(projects.id, id));
    else await deleteProject(env, id);
  }

  const [me] = await db.select({ role: user.role }).from(user).where(eq(user.id, userId));
  if (me?.role === "admin") {
    const admins = await db.select({ id: user.id }).from(user).where(and(eq(user.role, "admin"), ne(user.id, userId)));
    if (admins.length === 0) {
      const [next] = await db.select({ id: user.id }).from(user).where(ne(user.id, userId)).orderBy(asc(user.createdAt)).limit(1);
      if (next) await db.update(user).set({ role: "admin" }).where(eq(user.id, next.id));
    }
  }

  await db.batch([
    db.update(usageEvents).set({ userId: null }).where(eq(usageEvents.userId, userId)),
    db.delete(user).where(eq(user.id, userId)),
  ]);
}
