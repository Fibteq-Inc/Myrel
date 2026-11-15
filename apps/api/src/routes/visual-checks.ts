import { VisualCheckAction } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { type AppEnv, requireUser } from "../middleware";
import { findMembership } from "./projects";

/**
 * Mounted at /api/projects/:id/threads/:threadId/visual-checks: a person's answer to a visual check's
 * card (see checks/loop.ts). Any member may accept a round as it is or make its screenshots the
 * approved ones; the card says who did.
 */
export const visualCheckRoutes = new Hono<AppEnv>().use(requireUser).post("/:checkId/:action", async (c) => {
  const projectId = c.req.param("id")!;
  const threadId = c.req.param("threadId")!;
  const action = VisualCheckAction.safeParse(c.req.param("action"));
  if (!action.success) return c.json({ error: "not_found" }, 404);
  const me = c.get("user");
  if (!(await findMembership(c.env, projectId, me.id))) return c.json({ error: "not_found" }, 404);
  const project = await getAgentByName(c.env.PROJECT_AGENT, projectId);
  if (!(await project.getThread(threadId))) return c.json({ error: "not_found" }, 404);
  const thread = await getAgentByName(c.env.THREAD_AGENT, threadId);
  const refused = await thread.visualCheckAction({ checkId: c.req.param("checkId"), action: action.data, by: { id: me.id, name: me.name } });
  if (refused) return c.json({ error: "refused", message: refused }, 409);
  return c.body(null, 204);
});
