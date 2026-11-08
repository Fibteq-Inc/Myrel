import { createDb, schema } from "@myrel/db";
import { eq } from "drizzle-orm";

/** The project's visual check is on (ProjectSettings.visualCheck): interface work is checked before its pull request. */
export async function visualCheckOn(env: Env, projectId: string): Promise<boolean> {
  const [row] = await createDb(env.DB)
    .select({ visualCheck: schema.projects.visualCheck })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  return row?.visualCheck ?? false;
}
