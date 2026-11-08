import { createDb, schema } from "@myrel/db";
import { CheckModel } from "@myrel/protocol";
import { eq } from "drizzle-orm";

/** The project's visual check is on (ProjectSettings.visualCheck): interface work is checked before its pull request. */
export async function visualCheckOn(env: Env, projectId: string): Promise<boolean> {
  const [row] = await createDb(env.DB)
    .select({ visualCheck: schema.projects.visualCheck })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  return row?.visualCheck ?? false;
}

/** A CheckModel from its JSON column; anything unreadable counts as none. */
export function parseCheckModel(raw: string | null | undefined): CheckModel | null {
  if (!raw) return null;
  try {
    return CheckModel.nullable().catch(null).parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Who should judge a check: the project's choice and the person's own, either possibly unset. */
export async function checkModels(env: Env, projectId: string, userId: string | null): Promise<{ project: CheckModel | null; account: CheckModel | null }> {
  const db = createDb(env.DB);
  const [project] = await db.select({ checkModel: schema.projects.checkModel }).from(schema.projects).where(eq(schema.projects.id, projectId));
  const [person] = userId ? await db.select({ checkModel: schema.user.checkModel }).from(schema.user).where(eq(schema.user.id, userId)) : [];
  return { project: parseCheckModel(project?.checkModel), account: parseCheckModel(person?.checkModel) };
}
