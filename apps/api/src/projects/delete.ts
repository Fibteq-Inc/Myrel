import { createDb, schema } from "@altair/db";
import { getAgentByName } from "agents";
import { eq } from "drizzle-orm";
import { fileKey } from "../agents/knowledge";
import { workspaceName } from "../sandbox/workspace";

/**
 * Deletes a project and everything stored for it: the D1 rows (members, invites, repos and the
 * local folder cascade), its files and artifacts in R2, each thread's agent, sandbox and
 * Artifacts workspace, and the project agent's own storage. Usage rows stay: they are the billing
 * ledger and have no foreign keys on purpose.
 *
 * The D1 row goes first, so the project disappears for everyone at once; the rest is best effort
 * and logged, since a half-cleaned leftover is unreachable without the row.
 */
export async function deleteProject(env: Env, projectId: string): Promise<void> {
  const project = await getAgentByName(env.PROJECT_AGENT, projectId);
  const { threadIds, artifactIds } = await project.prepareDelete();
  await createDb(env.DB).delete(schema.projects).where(eq(schema.projects.id, projectId));

  const steps: Promise<unknown>[] = [
    deletePrefix(env.FILES, fileKey(projectId, "")),
    ...artifactIds.map((id) => deletePrefix(env.ARTIFACTS, `artifacts/${id}/`)),
    ...threadIds.map((id) => deleteThread(env, id)),
  ];
  const failed = (await Promise.allSettled(steps)).filter((r) => r.status === "rejected");
  for (const r of failed) console.error("project delete: cleanup step failed", projectId, (r as PromiseRejectedResult).reason);
  await project.wipe();
}

async function deleteThread(env: Env, threadId: string) {
  // The thread cancels its running task (sandbox or local) before its storage goes.
  const { usedSandbox } = await (await getAgentByName(env.THREAD_AGENT, threadId)).wipe();
  // Self-hosted servers may leave the sandbox and Artifacts bindings out.
  const optional = env as Partial<Env>;
  if (!usedSandbox) return;
  await Promise.all([
    optional.SANDBOX?.getByName(threadId).wipe(),
    optional.WORKSPACES?.delete(workspaceName(threadId)),
  ]);
}

async function deletePrefix(bucket: R2Bucket | undefined, prefix: string) {
  if (!bucket) return;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
