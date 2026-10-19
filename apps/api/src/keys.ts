import { createDb, schema } from "@altair/db";
import type { ApiKey, ProviderId } from "@altair/protocol";
import { and, desc, eq, isNull } from "drizzle-orm";
import { decryptSecret } from "./crypto";
import { createProvider, type ProviderOverride, type ProviderResult, serverProviderId } from "./llm";

const { apiKeys, projects } = schema;

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
  const db = createDb(env.DB);
  const [project] = await db
    .select({ provider: projects.llmProvider, model: projects.llmModel, keyId: projects.llmKeyId })
    .from(projects)
    .where(eq(projects.id, projectId));

  const override: ProviderOverride = { provider: project?.provider as ProviderId | null, model: project?.model };
  try {
    if (project?.keyId) {
      const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, project.keyId));
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
  return createProvider(env, fetchImpl, override);
}
