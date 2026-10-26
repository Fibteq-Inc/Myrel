import { CONNECTOR_OFFER_PREFIX, ConnectSuggestionInput } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { connectOffer, signInAgain } from "../connectors/suggest";
import { type AppEnv, requireUser } from "../middleware";
import { publicOrigin } from "./connectors";
import { findMembership } from "./projects";

/**
 * Mounted at /api/projects/:id/threads/:threadId/connector-suggestions: the answers to a connector
 * card the thread's agent posted. Any member may answer; what they connect is their own connector,
 * on in this project.
 */
export const connectorSuggestionRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .post("/:suggestionId/connect", async (c) => {
    const projectId = c.req.param("id")!;
    const threadId = c.req.param("threadId")!;
    const suggestionId = c.req.param("suggestionId");
    const userId = c.get("user").id;
    const member = await findMembership(c.env, projectId, userId);
    if (!member) return c.json({ error: "not_found" }, 404);
    const input = ConnectSuggestionInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    const project = await getAgentByName(c.env.PROJECT_AGENT, projectId);
    if (!(await project.getThread(threadId))) return c.json({ error: "not_found" }, 404);
    const thread = await getAgentByName(c.env.THREAD_AGENT, threadId);
    // The offer is read from the card Myrel posted, never from the request: a click connects only what the agent offered.
    const offer = await thread.openOffer(suggestionId, input.data.offerId);
    if (!offer) return c.json({ error: "not_found", message: "This card was already answered." }, 404);
    const back = { projectId, threadId, suggestionId, offerId: offer.id };
    const result = offer.id.startsWith(CONNECTOR_OFFER_PREFIX)
      ? await signInAgain(c.env, { userId, projectId, manages: member.role === "owner" || member.role === "admin", offer, origin: publicOrigin(c), back })
      : await connectOffer(c.env, { userId, projectId, offer, headers: input.data.headers, origin: publicOrigin(c), back });
    if (!result.ok) {
      const status = { limit_reached: 402, failed: 502, forbidden: 403, invalid_input: 400 } as const;
      return c.json({ error: result.error, message: result.message }, status[result.error]);
    }
    if (!result.connected) return c.json({ connected: false, authorizeUrl: result.authorizeUrl });
    await thread.suggestionConnected(suggestionId, offer.id, userId);
    return c.json({ connected: true });
  })
  .post("/:suggestionId/dismiss", async (c) => {
    const projectId = c.req.param("id")!;
    const threadId = c.req.param("threadId")!;
    const userId = c.get("user").id;
    if (!(await findMembership(c.env, projectId, userId))) return c.json({ error: "not_found" }, 404);
    const project = await getAgentByName(c.env.PROJECT_AGENT, projectId);
    if (!(await project.getThread(threadId))) return c.json({ error: "not_found" }, 404);
    const thread = await getAgentByName(c.env.THREAD_AGENT, threadId);
    if (!(await thread.dismissSuggestion(c.req.param("suggestionId"), userId))) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });
