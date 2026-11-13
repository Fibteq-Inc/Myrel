import { ResearchAction } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { type AppEnv, requireUser } from "../middleware";
import { findMembership } from "./projects";

/**
 * Mounted at /api/projects/:id/research: the project's researches by Claude (research/thread.ts),
 * for the Threads tab's research view, and Stop on a research's card.
 */
export const researchRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .get("/", async (c) => {
    const projectId = c.req.param("id")!;
    if (!(await findMembership(c.env, projectId, c.get("user").id))) return c.json({ error: "not_found" }, 404);
    const project = await getAgentByName(c.env.PROJECT_AGENT, projectId);
    return c.json({ research: await project.listResearch() });
  })
  .post("/:researchId/:action", async (c) => {
    const projectId = c.req.param("id")!;
    const action = ResearchAction.safeParse(c.req.param("action"));
    if (!action.success) return c.json({ error: "not_found" }, 404);
    const me = c.get("user");
    const membership = await findMembership(c.env, projectId, me.id);
    if (!membership) return c.json({ error: "not_found" }, 404);
    const project = await getAgentByName(c.env.PROJECT_AGENT, projectId);
    const research = await project.getResearch(c.req.param("researchId"));
    if (!research) return c.json({ error: "not_found" }, 404);
    const thread = await getAgentByName(c.env.THREAD_AGENT, research.threadId);
    const refused = await thread.researchStop({
      researchId: research.id,
      by: { id: me.id, name: me.name, admin: membership.role === "owner" || membership.role === "admin" },
    });
    if (refused) return c.json({ error: "refused", message: refused }, 409);
    return c.body(null, 204);
  });
