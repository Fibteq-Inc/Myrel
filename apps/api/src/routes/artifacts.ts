import { artifactObjectKey, artifactPath, type ArtifactView } from "@altair/protocol";
import { signArtifact } from "@altair/protocol/artifact-signature";
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { type AppEnv, requireUser } from "../middleware";
import { findMembership } from "./projects";

/** How long a signed artifact link works. The app asks for a fresh one each time it opens a viewer. */
const VIEW_TTL_MS = 60 * 60 * 1000;

/** Mounted at /api/projects/:id/artifacts. */
export const artifactRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .use(async (c, next) => {
    const id = c.req.param("id")!;
    if (!(await findMembership(c.env, id, c.get("user").id))) return c.json({ error: "not_found" }, 404);
    await next();
  })
  .get("/", async (c) => {
    const agent = await getAgentByName(c.env.PROJECT_AGENT, c.req.param("id")!);
    return c.json({ artifacts: await agent.listArtifacts() });
  })
  .get("/:artifactId", async (c) => {
    const agent = await getAgentByName(c.env.PROJECT_AGENT, c.req.param("id")!);
    const found = await agent.getArtifact(c.req.param("artifactId"));
    return found ? c.json(found) : c.json({ error: "not_found" }, 404);
  })
  /** A signed link to one version (default: the latest) on the artifact origin. */
  .get("/:artifactId/view", async (c) => {
    const artifactId = c.req.param("artifactId");
    const agent = await getAgentByName(c.env.PROJECT_AGENT, c.req.param("id")!);
    const found = await agent.getArtifact(artifactId);
    if (!found) return c.json({ error: "not_found" }, 404);
    const version = c.req.query("version") ? Number(c.req.query("version")) : found.artifact.version;
    if (!found.versions.some((v) => v.version === version)) return c.json({ error: "not_found" }, 404);

    const origin = c.env.ARTIFACTS_URL?.replace(/\/$/, "");
    const secret = c.env.ARTIFACT_SIGNING_SECRET;
    if (!origin || !secret) return c.json({ version, url: null, expiresAt: null } satisfies ArtifactView);
    const exp = Date.now() + VIEW_TTL_MS;
    const sig = await signArtifact(secret, artifactId, version, exp);
    const url = `${origin}${artifactPath(artifactId, version)}?exp=${exp}&sig=${sig}`;
    return c.json({ version, url, expiresAt: new Date(exp).toISOString() } satisfies ArtifactView);
  })
  /** One version's HTML as plain text, for the viewer's code tab. Never rendered on this origin. */
  .get("/:artifactId/versions/:version/source", async (c) => {
    const artifactId = c.req.param("artifactId");
    const version = Number(c.req.param("version"));
    const agent = await getAgentByName(c.env.PROJECT_AGENT, c.req.param("id")!);
    if (!Number.isInteger(version) || !(await agent.hasArtifactVersion(artifactId, version))) {
      return c.json({ error: "not_found" }, 404);
    }
    const object = await c.env.ARTIFACTS.get(artifactObjectKey(artifactId, version));
    if (!object) return c.json({ error: "not_found" }, 404);
    return new Response(object.body, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=3600",
      },
    });
  });
