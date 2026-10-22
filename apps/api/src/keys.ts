import { createDb, schema } from "@myrel/db";
import type { ApiKey, ProviderId } from "@myrel/protocol";
import { and, desc, eq, isNull } from "drizzle-orm";
import { decryptSecret } from "./crypto";
import { createProvider, type ProviderOverride, type ProviderResult, serverProviderId, taskModel } from "./llm";

const { apiKeys, projectMembers, projects } = schema;

async function keyOwnerIsMember(env: Env, projectId: string, userId: string): Promise<boolean> {
  const [row] = await createDb(env.DB)
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return Boolean(row);
}

type KeyRow = typeof apiKeys.$inferSelect;

export function toApiKey(row: Pick<KeyRow, "id" | "provider" | "label" | "hint" | "ownerId" | "createdAt">): ApiKey {
  return {
    id: row.id,
    provider: row.provider as ProviderId,
    label: row.label,
    hint: row.hint,
    scope: row.ownerId ? "user" : "instance",
    createdAt: row.createdAt.toISOString(),
  };
}

/** Newest instance key for a provider, decrypted, or null. */
export async function instanceKey(env: Env, provider: string): Promise<string | null> {
  const [row] = await createDb(env.DB)
    .select()
    .from(apiKeys)
    .where(and(isNull(apiKeys.ownerId), eq(apiKeys.provider, provider)))
    .orderBy(desc(apiKeys.createdAt))
    .limit(1);
  return row ? decryptSecret(env, row.secret, row.id) : null;
}

/**
 * The model provider a project's agents use: the project's provider, model and key when set,
 * else an instance key for that provider, else the Worker secret (see createProvider).
 */
export async function projectProvider(env: Env, projectId: string, fetchImpl?: typeof fetch): Promise<ProviderResult> {
  const override = await projectOverride(env, projectId);
  return override.ok ? createProvider(env, fetchImpl, override.value) : override;
}

/** The model and key run_task hands to a coding harness, chosen the same way as the agents'. */
export async function projectTaskModel(env: Env, projectId: string): Promise<ReturnType<typeof taskModel>> {
  const override = await projectOverride(env, projectId);
  return override.ok ? taskModel(env, override.value) : override;
}

async function projectOverride(
  env: Env,
  projectId: string,
): Promise<{ ok: true; value: ProviderOverride } | { ok: false; reason: string }> {
  const db = createDb(env.DB);
  const [project] = await db
    .select({ provider: projects.llmProvider, model: projects.llmModel, keyId: projects.llmKeyId })
    .from(projects)
    .where(eq(projects.id, projectId));

  const override: ProviderOverride = { provider: project?.provider as ProviderId | null, model: project?.model };
  try {
    if (project?.keyId) {
      const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, project.keyId));
      // A person's own key works for the projects they are in, never for one they have left.
      if (key?.ownerId && !(await keyOwnerIsMember(env, projectId, key.ownerId))) {
        return { ok: false, reason: "The project's model key belongs to someone who is no longer in it. Choose another key in Settings." };
      }
      if (key) {
        override.provider = key.provider as ProviderId;
        override.apiKey = await decryptSecret(env, key.secret, key.id);
      }
    }
    override.apiKey ||= await instanceKey(env, override.provider || serverProviderId(env));
  } catch (err) {
    console.error("could not decrypt model key", err);
    return { ok: false, reason: "The project's model key could not be decrypted. Add it again in Settings." };
  }
  return { ok: true, value: override };
}
