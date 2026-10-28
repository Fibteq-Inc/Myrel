import { createDb, schema } from "@myrel/db";
import { type AdminErrorGroup, type AdminFunnel, type AdminSettings, UpdateAdminSettingsInput } from "@myrel/protocol";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { setSignUpEnabled, signUpEnabled } from "../instance";
import { type AppEnv, requireAdmin, requireUser } from "../middleware";

const { errorGroups } = schema;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Server settings for instance admins, and what they watch: the server's errors and newcomers' first steps. */
export const adminRoutes = new Hono<AppEnv>()
  .use(requireUser, requireAdmin)
  .get("/settings", async (c) => c.json({ settings: { signUpEnabled: await signUpEnabled(c.env) } satisfies AdminSettings }))
  .patch("/settings", async (c) => {
    const input = UpdateAdminSettingsInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    if (input.data.signUpEnabled !== undefined) await setSignUpEnabled(c.env, input.data.signUpEnabled);
    return c.json({ settings: { signUpEnabled: await signUpEnabled(c.env) } satisfies AdminSettings });
  })
  // The newest 100 kinds of failure, last seen first.
  .get("/errors", async (c) => {
    const rows = await createDb(c.env.DB).select().from(errorGroups).orderBy(desc(errorGroups.lastSeenAt)).limit(100);
    const errors = rows.map(
      (r) =>
        ({
          ...r,
          source: r.source as AdminErrorGroup["source"],
          firstSeenAt: r.firstSeenAt.getTime(),
          lastSeenAt: r.lastSeenAt.getTime(),
        }) satisfies AdminErrorGroup,
    );
    return c.json({ errors });
  })
  // Fixed: the group goes away until it happens again.
  .delete("/errors/:id", async (c) => {
    await createDb(c.env.DB).delete(errorGroups).where(eq(errorGroups.id, c.req.param("id")));
    return c.body(null, 204);
  })
  .get("/funnel", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 365);
    const since = Date.now() - days * DAY_MS;
    // One pass over the newcomers; each step is an EXISTS on a table that already holds it.
    const row = await c.env.DB.prepare(
      `SELECT
         count(*) AS signedUp,
         sum(u.email_verified) AS verified,
         sum(EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = u.id)) AS inProject,
         sum(EXISTS (SELECT 1 FROM usage_events e WHERE e.user_id = u.id AND e.agent = 'coordinator')) AS asked,
         sum(EXISTS (SELECT 1 FROM usage_events e WHERE e.user_id = u.id AND e.agent = 'thread')) AS threadRan,
         sum(EXISTS (SELECT 1 FROM runners r WHERE r.user_id = u.id)) AS pairedComputer
       FROM user u WHERE u.created_at >= ?`,
    )
      .bind(since)
      .first<Record<Exclude<keyof AdminFunnel, "days">, number | null>>();
    const n = (v: number | null | undefined) => v ?? 0;
    const funnel: AdminFunnel = {
      days,
      signedUp: n(row?.signedUp),
      verified: n(row?.verified),
      inProject: n(row?.inProject),
      asked: n(row?.asked),
      threadRan: n(row?.threadRan),
      pairedComputer: n(row?.pairedComputer),
    };
    return c.json({ funnel });
  });
