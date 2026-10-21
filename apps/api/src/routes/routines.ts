import { CreateRoutineInput, UpdateRoutineInput } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { type AppEnv, requireUser } from "../middleware";
import { findMembership } from "./projects";

/** Mounted at /projects/:projectId/routines. Every member can manage the project's routines. */
export const routineRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .use(async (c, next) => {
    const projectId = c.req.param("projectId")!;
    if (!(await findMembership(c.env, projectId, c.get("user").id))) return c.json({ error: "not_found" }, 404);
    await next();
  })
  .get("/", async (c) => {
    const agent = await getAgentByName(c.env.PROJECT_AGENT, c.req.param("projectId")!);
    return c.json({ routines: await agent.listRoutines() });
  })
  .post("/", async (c) => {
    const input = CreateRoutineInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    const agent = await getAgentByName(c.env.PROJECT_AGENT, c.req.param("projectId")!);
    try {
      return c.json({ routine: await agent.createRoutine(input.data, c.get("user").id) }, 201);
    } catch (err) {
      return c.json({ error: "invalid_input", message: err instanceof Error ? err.message : String(err) }, 400);
    }
  })
  .patch("/:routineId", async (c) => {
    const input = UpdateRoutineInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    const agent = await getAgentByName(c.env.PROJECT_AGENT, c.req.param("projectId")!);
    try {
      const routine = await agent.updateRoutine(c.req.param("routineId"), input.data, c.get("user").id);
      return routine ? c.json({ routine }) : c.json({ error: "not_found" }, 404);
    } catch (err) {
      return c.json({ error: "invalid_input", message: err instanceof Error ? err.message : String(err) }, 400);
    }
  })
  .post("/:routineId/run", async (c) => {
    const agent = await getAgentByName(c.env.PROJECT_AGENT, c.req.param("projectId")!);
    const routine = await agent.runRoutineNow(c.req.param("routineId"));
    return routine ? c.json({ routine }) : c.json({ error: "not_found" }, 404);
  })
  .delete("/:routineId", async (c) => {
    const agent = await getAgentByName(c.env.PROJECT_AGENT, c.req.param("projectId")!);
    return (await agent.deleteRoutine(c.req.param("routineId")))
      ? c.json({ ok: true })
      : c.json({ error: "not_found" }, 404);
  });
