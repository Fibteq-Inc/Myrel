import { CreateReportInput } from "@myrel/protocol";
import { Hono } from "hono";
import { type AppEnv, requireUser } from "../middleware";
import { blockMember, reportContent, unblockMember } from "../moderation";
import { findMembership } from "./projects";

/** The server's public origin, for links in emails. */
function origin(c: { env: Env; req: { url: string } }) {
  return c.env.BETTER_AUTH_URL?.replace(/\/$/, "") || new URL(c.req.url).origin;
}

/** Mounted at /api/projects/:id/reports: anyone in the project reports a message or an artifact of it. */
export const reportRoutes = new Hono<AppEnv>().use(requireUser).post("/", async (c) => {
  const id = c.req.param("id")!;
  const me = c.get("user");
  const project = await findMembership(c.env, id, me.id);
  if (!project) return c.json({ error: "not_found" }, 404);
  const input = CreateReportInput.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
  const result = await reportContent(c.env, {
    project: { id, name: project.name },
    reporter: { id: me.id, name: me.name, email: me.email },
    report: input.data,
    origin: origin(c),
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true }, result.duplicate ? 200 : 201);
});

/**
 * Mounted at /api/projects/:id/blocks: PUT /:userId blocks a member of the project for the caller,
 * DELETE /:userId lifts it. A block holds in every project the two share.
 */
export const blockRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .put("/:userId", async (c) => {
    const { id, userId } = c.req.param() as { id: string; userId: string };
    const me = c.get("user");
    const project = await findMembership(c.env, id, me.id);
    if (!project) return c.json({ error: "not_found" }, 404);
    if (userId === me.id) return c.json({ error: "invalid_input", message: "You cannot block yourself." }, 400);
    if (!(await findMembership(c.env, id, userId))) return c.json({ error: "not_found" }, 404);
    await blockMember(c.env, {
      project: { id, name: project.name },
      blocker: { id: me.id, name: me.name, email: me.email },
      blockedId: userId,
      origin: origin(c),
    });
    return c.json({ ok: true });
  })
  .delete("/:userId", async (c) => {
    const { id, userId } = c.req.param() as { id: string; userId: string };
    const me = c.get("user");
    if (!(await findMembership(c.env, id, me.id))) return c.json({ error: "not_found" }, 404);
    await unblockMember(c.env, me.id, userId);
    return c.body(null, 204);
  });
