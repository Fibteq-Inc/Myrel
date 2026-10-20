import { createDb, schema } from "@myrel/db";
import { createId, CreateApiKeyInput, type Invite, type Me, ProviderId, type ProviderInfo } from "@myrel/protocol";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { encryptSecret, keyHint } from "../crypto";
import { deleteAccount } from "../delete-account";
import { toApiKey } from "../keys";
import { PROVIDERS, serverProviderId } from "../llm";
import { type AppEnv, requireUser } from "../middleware";
import { UNVERIFIED_MESSAGE } from "../verification";

const { apiKeys, projectInvites, projectMembers, projects, user } = schema;

/** The signed-in user (mounted at /api/account): profile, model providers and keys, invitations. */
export const accountRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .get("/", (c) => {
    const { id, name, email, role } = c.get("user");
    return c.json({ user: { id, name, email, role } satisfies Me });
  })
  .delete("/", async (c) => {
    await deleteAccount(c.env, c.get("user").id);
    return c.body(null, 204);
  })

  // ---- Model providers and keys ----

  .get("/providers", async (c) => {
    const instanceKeys = await createDb(c.env.DB)
      .select({ provider: apiKeys.provider })
      .from(apiKeys)
      .where(isNull(apiKeys.ownerId));
    const providers: ProviderInfo[] = ProviderId.options.map((id) => {
      const def = PROVIDERS[id];
      return {
        id,
        name: PROVIDER_NAMES[id],
        defaultModel: id === serverProviderId(c.env) && c.env.LLM_MODEL ? c.env.LLM_MODEL : def.defaultModel,
        serverKey: Boolean(c.env[def.keyVar]) || instanceKeys.some((k) => k.provider === id),
      };
    });
    return c.json({ providers, serverDefault: serverProviderId(c.env) });
  })
  .get("/keys", async (c) => {
    const rows = await createDb(c.env.DB)
      .select()
      .from(apiKeys)
      .where(or(eq(apiKeys.ownerId, c.get("user").id), isNull(apiKeys.ownerId)))
      .orderBy(desc(apiKeys.createdAt));
    return c.json({ keys: rows.map(toApiKey) });
  })
  .post("/keys", async (c) => {
    const input = CreateApiKeyInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    const me = c.get("user");
    if (input.data.scope === "instance" && me.role !== "admin") return c.json({ error: "forbidden" }, 403);

    const id = createId("apiKey");
    const createdAt = new Date();
    const row = {
      id,
      ownerId: input.data.scope === "instance" ? null : me.id,
      provider: input.data.provider,
      label: input.data.label,
      secret: await encryptSecret(c.env, input.data.key, id),
      hint: keyHint(input.data.key),
      createdAt,
      updatedAt: createdAt,
    };
    await createDb(c.env.DB).insert(apiKeys).values(row);
    return c.json({ key: toApiKey(row) }, 201);
  })
  .delete("/keys/:id", async (c) => {
    const me = c.get("user");
    const db = createDb(c.env.DB);
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, c.req.param("id")));
    const mayDelete = key && (key.ownerId ? key.ownerId === me.id : me.role === "admin");
    if (!mayDelete) return c.json({ error: "not_found" }, 404);
    await db.batch([
      db.update(projects).set({ llmKeyId: null }).where(eq(projects.llmKeyId, key.id)),
      db.delete(apiKeys).where(eq(apiKeys.id, key.id)),
    ]);
    return c.body(null, 204);
  })

  // ---- Invitations addressed to me ----

  .get("/invites", async (c) => {
    // An invitation is for whoever owns the address, which an unverified account has not shown.
    if (!c.get("user").verified) return c.json({ invites: [] });
    const rows = await createDb(c.env.DB)
      .select({
        id: projectInvites.id,
        projectId: projectInvites.projectId,
        projectName: projects.name,
        email: projectInvites.email,
        role: projectInvites.role,
        invitedBy: user.name,
        createdAt: projectInvites.createdAt,
      })
      .from(projectInvites)
      .innerJoin(projects, eq(projects.id, projectInvites.projectId))
      .innerJoin(user, eq(user.id, projectInvites.invitedBy))
      .where(eq(projectInvites.email, c.get("user").email.toLowerCase()))
      .orderBy(desc(projectInvites.createdAt));
    return c.json({ invites: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }) satisfies Invite) });
  })
  .post("/invites/:id/accept", async (c) => {
    const me = c.get("user");
    if (!me.verified) return c.json({ error: "email_not_verified", message: UNVERIFIED_MESSAGE }, 403);
    const db = createDb(c.env.DB);
    const invite = await myInvite(c.env, c.req.param("id"), me.email);
    if (!invite) return c.json({ error: "not_found" }, 404);
    await db.batch([
      db
        .insert(projectMembers)
        .values({ projectId: invite.projectId, userId: me.id, role: invite.role })
        .onConflictDoNothing(),
      db.delete(projectInvites).where(eq(projectInvites.id, invite.id)),
    ]);
    return c.json({ projectId: invite.projectId });
  })
  .delete("/invites/:id", async (c) => {
    const invite = await myInvite(c.env, c.req.param("id"), c.get("user").email);
    if (!invite) return c.json({ error: "not_found" }, 404);
    await createDb(c.env.DB).delete(projectInvites).where(eq(projectInvites.id, invite.id));
    return c.body(null, 204);
  });

const PROVIDER_NAMES: Record<ProviderId, string> = {
  fireworks: "Fireworks AI",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

async function myInvite(env: Env, id: string, email: string) {
  const [invite] = await createDb(env.DB)
    .select()
    .from(projectInvites)
    .where(and(eq(projectInvites.id, id), eq(projectInvites.email, email.toLowerCase())));
  return invite ?? null;
}
