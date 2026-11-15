import { createDb, schema } from "@myrel/db";
import { CheckModels } from "@myrel/protocol";
import { eq } from "drizzle-orm";

/** The project's visual check is on (ProjectSettings.visualCheck): interface work is checked before its pull request. */
export async function visualCheckOn(env: Env, projectId: string): Promise<boolean> {
  const [row] = await createDb(env.DB)
    .select({ visualCheck: schema.projects.visualCheck })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  return row?.visualCheck ?? false;
}

/** A CheckModels list from its JSON column; anything unreadable counts as none. */
export function parseCheckModels(raw: string | null | undefined): CheckModels {
  if (!raw) return {};
  try {
    return CheckModels.catch({}).parse(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** The CLIs that may judge a check: the project's list and the person's own, either possibly empty. */
export async function checkModels(env: Env, projectId: string, userId: string | null): Promise<{ project: CheckModels; account: CheckModels }> {
  const db = createDb(env.DB);
  const [project] = await db.select({ checkModels: schema.projects.checkModels }).from(schema.projects).where(eq(schema.projects.id, projectId));
  const [person] = userId ? await db.select({ checkModels: schema.user.checkModels }).from(schema.user).where(eq(schema.user.id, userId)) : [];
  return { project: parseCheckModels(project?.checkModels), account: parseCheckModels(person?.checkModels) };
}
