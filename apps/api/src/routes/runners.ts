import { createDb, schema } from "@altair/db";
import {
  createId,
  PairRunnerInput,
  type PairRunnerResult,
  RunnerFolderInput,
  type RunnerPairingCode,
} from "@altair/protocol";
import { getAgentByName } from "agents";
import { and, desc, eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import { type AppEnv, requireUser } from "../middleware";
import {
  newPairingCode,
  newRunnerToken,
  normalizeCode,
  notifyProject,
  PAIRING_TTL_MS,
  RUNNER_ID_HEADER,
  sha256Hex,
  toRunner,
} from "../runners";

const { runners, runnerPairings } = schema;

/**
 * Endpoints the altair-runner daemon calls. They authenticate with a pairing
 * code or the runner's own token, never with a user session.
 */
export const runnerDeviceRoutes = new Hono<AppEnv>()
  // `altair-runner pair` trades a code from the web app for a runner token.
  .post("/pair", async (c) => {
    const input = PairRunnerInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);

    const db = createDb(c.env.DB);
    const codeHash = await sha256Hex(normalizeCode(input.data.code));
    // Single use: deleting and reading in one statement means two racing pairs cannot both win.
    const [pairing] = await db.delete(runnerPairings).where(eq(runnerPairings.codeHash, codeHash)).returning();
    if (!pairing || pairing.expiresAt.getTime() < Date.now()) {
      return c.json({ error: "invalid_code", message: "This code is wrong or has expired. Create a new one in Altair." }, 400);
    }

    const id = createId("runner");
    const token = newRunnerToken();
    await db.insert(runners).values({
      id,
      userId: pairing.userId,
      name: input.data.name,
      tokenHash: await sha256Hex(token),
      info: null,
    });
    return c.json({ runner: { id, name: input.data.name }, token } satisfies PairRunnerResult, 201);
  })
  // Whether the runner's token is still valid, so it can tell "unpaired" from "server unreachable".
  .get("/me", async (c) => {
    const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const [runner] = token
      ? await createDb(c.env.DB)
          .select({ id: runners.id, name: runners.name })
          .from(runners)
          .where(eq(runners.tokenHash, await sha256Hex(token)))
      : [];
    if (!runner) return c.json({ error: "unauthorized" }, 401);
    return c.json({ runner });
  })
  // The runner's live connection. Token in `Authorization: Bearer`.
  .get("/connect", async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: "expected_websocket" }, 426);
    }
    const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const [runner] = await createDb(c.env.DB)
      .select({ id: runners.id })
      .from(runners)
      .where(eq(runners.tokenHash, await sha256Hex(token)));
    if (!runner) return c.json({ error: "unauthorized" }, 401);

    // The DO trusts this header; it is always overwritten here, never taken from the client.
    const headers = new Headers(c.req.raw.headers);
    headers.set(RUNNER_ID_HEADER, runner.id);
    headers.delete("authorization");
    const agent = await getAgentByName(c.env.RUNNER_AGENT, runner.id);
    return agent.fetch(new Request(c.req.raw, { headers }));
  });

/** The signed-in user's computers. */
export const runnerRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .get("/", async (c) => {
    const rows = await createDb(c.env.DB)
      .select()
      .from(runners)
      .where(eq(runners.userId, c.get("user").id))
      .orderBy(desc(runners.createdAt));
    return c.json({ runners: await Promise.all(rows.map((r) => toRunner(c.env, r))) });
  })
  // A code for `altair-runner pair`. Codes are stored hashed and expire after a few minutes.
  .post("/pairing", async (c) => {
    const db = createDb(c.env.DB);
    await db.delete(runnerPairings).where(lt(runnerPairings.expiresAt, new Date()));
    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await db.insert(runnerPairings).values({
      codeHash: await sha256Hex(normalizeCode(code)),
      userId: c.get("user").id,
      expiresAt,
    });
    return c.json({ code, expiresAt: expiresAt.toISOString() } satisfies RunnerPairingCode, 201);
  })
  // Browses the computer's folders, for the folder picker. Only the computer's owner can.
  .get("/:id/dirs", async (c) => {
    const id = c.req.param("id");
    if (!(await ownsRunner(c.env, id, c.get("user").id))) return c.json({ error: "not_found" }, 404);
    const agent = await getAgentByName(c.env.RUNNER_AGENT, id);
    const result = await agent.listDirs(c.req.query("path") || undefined);
    if (!result.ok) return c.json({ error: "runner_failed", message: result.reason }, 409);
    return c.json(result.listing);
  })
  // Shares a folder on the computer, as `altair-runner share` would.
  .post("/:id/folders", async (c) => {
    const id = c.req.param("id");
    const input = RunnerFolderInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    if (!(await ownsRunner(c.env, id, c.get("user").id))) return c.json({ error: "not_found" }, 404);
    const agent = await getAgentByName(c.env.RUNNER_AGENT, id);
    const result = await agent.setShared(input.data.path, true);
    if (!result.ok) return c.json({ error: "runner_failed", message: result.reason }, 409);
    return c.json({ folders: result.folders });
  })
  // Stops sharing a folder. Projects working in it lose their local folder.
  .delete("/:id/folders", async (c) => {
    const id = c.req.param("id");
    const input = RunnerFolderInput.safeParse({ path: c.req.query("path") });
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    if (!(await ownsRunner(c.env, id, c.get("user").id))) return c.json({ error: "not_found" }, 404);
    const agent = await getAgentByName(c.env.RUNNER_AGENT, id);
    const result = await agent.setShared(input.data.path, false);
    if (!result.ok) return c.json({ error: "runner_failed", message: result.reason }, 409);
    const { projectWorkspaces } = schema;
    const stale = and(eq(projectWorkspaces.runnerId, id), eq(projectWorkspaces.path, input.data.path));
    const affected = await createDb(c.env.DB).delete(projectWorkspaces).where(stale).returning();
    await Promise.all(affected.map((r) => notifyProject(c.env, r.projectId)));
    return c.json({ folders: result.folders });
  })
  // Unpairs a computer: its token stops working and projects lose that folder.
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const db = createDb(c.env.DB);
    const owned = and(eq(runners.id, id), eq(runners.userId, c.get("user").id));
    const [row] = await db.select({ id: runners.id }).from(runners).where(owned);
    if (!row) return c.json({ error: "not_found" }, 404);
    const affected = await db
      .select({ projectId: schema.projectWorkspaces.projectId })
      .from(schema.projectWorkspaces)
      .where(eq(schema.projectWorkspaces.runnerId, id));
    await db.delete(runners).where(owned); // cascades to those projects' workspace rows
    const agent = await getAgentByName(c.env.RUNNER_AGENT, id);
    await agent.revoke();
    await Promise.all(affected.map((r) => notifyProject(c.env, r.projectId)));
    return c.json({ ok: true });
  });

async function ownsRunner(env: Env, runnerId: string, userId: string): Promise<boolean> {
  const [row] = await createDb(env.DB)
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.id, runnerId), eq(runners.userId, userId)));
  return Boolean(row);
}
