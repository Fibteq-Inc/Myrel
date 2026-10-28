import { createDb, schema } from "@myrel/db";
import { createId, CreateSshHostInput, RunnerId, SshHostKey, TrustSshHostInput, UpdateSshHostInput } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { canAddSshHost } from "../extensions";
import { type AppEnv, requireUser } from "../middleware";
import { listWorkspaces } from "../runners";
import { ownsComputer } from "../sandbox/backend";
import { findSshHost, presentSshHosts, projectSshHostRows, type SshHostRow, sshHistory, sshTarget } from "../ssh/store";
import { findMembership } from "./projects";

const { projectSshHosts } = schema;

/**
 * Mounted at /api/projects/:id/ssh: the servers the project's agents may reach over SSH (phase 1:
 * through a local runner). Members see them and their history. Only the owner of the computer that
 * holds a server's key sets it up there (makes the key, confirms the server's key, tests, turns it
 * on); a project owner or admin can also turn a server off or remove it.
 */
export const sshRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .get("/", async (c) => {
    const member = await membership(c);
    if (!member) return c.json({ error: "not_found" }, 404);
    const rows = await projectSshHostRows(c.env, member.projectId);
    return c.json({ hosts: await presentSshHosts(c.env, rows, c.get("user").id), history: await sshHistory(c.env, member.projectId) });
  })
  // The keys already in ~/.ssh on one of your computers, by name and fingerprint.
  .get("/keys", async (c) => {
    const member = await membership(c);
    if (!member) return c.json({ error: "not_found" }, 404);
    const runnerId = RunnerId.safeParse(c.req.query("runnerId"));
    if (!runnerId.success || !(await ownsComputer(c.env, runnerId.data, c.get("user").id))) return c.json({ error: "forbidden", message: NOT_YOURS }, 403);
    const answer = await (await getAgentByName(c.env.RUNNER_AGENT, runnerId.data)).sshKeys();
    if (!answer.ok) return c.json({ error: "runner_failed", message: answer.reason }, 502);
    return c.json({ keys: answer.keys });
  })
  .post("/hosts", async (c) => {
    const member = await membership(c);
    if (!member) return c.json({ error: "not_found" }, 404);
    const input = CreateSshHostInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    const data = input.data;
    const userId = c.get("user").id;
    // The key goes on one of your own computers this project works on.
    const workspaces = await listWorkspaces(c.env, member.projectId, userId);
    if (!workspaces.some((w) => w.runnerId === data.runnerId)) return c.json({ error: "forbidden", message: NOT_YOURS }, 403);
    const [taken] = await createDb(c.env.DB)
      .select({ id: projectSshHosts.id })
      .from(projectSshHosts)
      .where(and(eq(projectSshHosts.projectId, member.projectId), eq(projectSshHosts.alias, data.alias)));
    if (taken) return c.json({ error: "conflict", message: `This project already has a server called ${data.alias}.` }, 409);

    const allowed = await canAddSshHost(c.env, userId);
    if (!allowed.ok) return c.json({ error: "limit_reached", message: allowed.reason }, 402);

    const id = createId("sshHost");
    const runner = await getAgentByName(c.env.RUNNER_AGENT, data.runnerId);
    const key = await runner.sshKeygen({ projectId: member.projectId, alias: data.alias }, `myrel:${slug(member.name)}:${data.alias}`, data.existingKey);
    if (!key.ok) return c.json({ error: "runner_failed", message: key.reason }, 502);
    await createDb(c.env.DB)
      .insert(projectSshHosts)
      .values({
        id,
        projectId: member.projectId,
        alias: data.alias,
        host: data.host,
        port: data.port,
        user: data.user,
        runnerId: data.runnerId,
        keySource: data.existingKey ? "existing" : "new",
        publicKey: key.publicKey,
        keyFingerprint: key.fingerprint,
        rule: "ask",
        createdBy: userId,
      });
    const row = await findSshHost(c.env, member.projectId, id);
    const [host] = await presentSshHosts(c.env, row ? [row] : [], userId);
    return c.json({ host, protected: key.protected }, 201);
  })
  // The server's own keys, as the computer sees them, for the person to compare by fingerprint.
  .post("/hosts/:hostId/scan", async (c) => {
    const found = await ownHost(c);
    if (!found.ok) return found.response;
    const answer = await (await getAgentByName(c.env.RUNNER_AGENT, found.row.runnerId)).sshHostKeys(found.row.host, found.row.port);
    if (!answer.ok) return c.json({ error: "runner_failed", message: answer.reason }, 502);
    return c.json({ keys: answer.keys });
  })
  // The person confirmed this server key: it is kept (on the computer too), then a login is tried.
  .post("/hosts/:hostId/trust", async (c) => {
    const found = await ownHost(c);
    if (!found.ok) return found.response;
    const input = TrustSshHostInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    // Only a key the server itself shows now, so a typo cannot pin something else.
    const runner = await getAgentByName(c.env.RUNNER_AGENT, found.row.runnerId);
    const scan = await runner.sshHostKeys(found.row.host, found.row.port);
    if (!scan.ok) return c.json({ error: "runner_failed", message: scan.reason }, 502);
    const picked = scan.keys.find((k: SshHostKey) => k.key === input.data.hostKey.trim().split(/\s+/).slice(0, 2).join(" "));
    if (!picked) return c.json({ error: "invalid_input", message: "The server no longer shows this key. Fetch its keys again." }, 409);
    await createDb(c.env.DB)
      .update(projectSshHosts)
      .set({ hostKey: picked.key, hostFingerprint: picked.fingerprint, testedAt: null })
      .where(eq(projectSshHosts.id, found.row.id));
    return test(c, { ...found.row, hostKey: picked.key, hostFingerprint: picked.fingerprint });
  })
  .post("/hosts/:hostId/test", async (c) => {
    const found = await ownHost(c);
    if (!found.ok) return found.response;
    return test(c, found.row);
  })
  .patch("/hosts/:hostId", async (c) => {
    const input = UpdateSshHostInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    // Anyone who manages the project can turn a server off; only its computer's owner turns it on.
    const found = input.data.rule === "off" ? await managedHost(c) : await ownHost(c);
    if (!found.ok) return found.response;
    await createDb(c.env.DB).update(projectSshHosts).set({ rule: input.data.rule }).where(eq(projectSshHosts.id, found.row.id));
    const row = await findSshHost(c.env, found.row.projectId, found.row.id);
    const [host] = await presentSshHosts(c.env, row ? [row] : [], c.get("user").id);
    return c.json({ host });
  })
  .delete("/hosts/:hostId", async (c) => {
    const found = await managedHost(c);
    if (!found.ok) return found.response;
    // The key Myrel made goes too, when the computer is there to delete it.
    const runner = await getAgentByName(c.env.RUNNER_AGENT, found.row.runnerId);
    const forgot = await runner.sshForget({ projectId: found.row.projectId, alias: found.row.alias }).catch(() => ({ ok: false as const, reason: "" }));
    await createDb(c.env.DB).delete(projectSshHosts).where(eq(projectSshHosts.id, found.row.id));
    return c.json({ ok: true, keyDeleted: forgot.ok });
  });

const NOT_YOURS = "Only the owner of the computer that holds the key can do this.";

async function membership(c: Context<AppEnv>) {
  const projectId = c.req.param("id")!;
  const project = await findMembership(c.env, projectId, c.get("user").id);
  return project ? { projectId, name: project.name, role: project.role } : null;
}

type Found = { ok: true; row: SshHostRow } | { ok: false; response: Response };

/** A server whose key is on your computer. */
async function ownHost(c: Context<AppEnv>): Promise<Found> {
  const member = await membership(c);
  const row = member ? await findSshHost(c.env, member.projectId, c.req.param("hostId")!) : null;
  if (!row) return { ok: false, response: c.json({ error: "not_found" }, 404) };
  if (!(await ownsComputer(c.env, row.runnerId, c.get("user").id))) return { ok: false, response: c.json({ error: "forbidden", message: NOT_YOURS }, 403) };
  return { ok: true, row };
}

/** A server you may turn off or remove: on your computer, or in a project you own or run. */
async function managedHost(c: Context<AppEnv>): Promise<Found> {
  const member = await membership(c);
  const row = member ? await findSshHost(c.env, member.projectId, c.req.param("hostId")!) : null;
  if (!member || !row) return { ok: false, response: c.json({ error: "not_found" }, 404) };
  const manages = member.role === "owner" || member.role === "admin" || (await ownsComputer(c.env, row.runnerId, c.get("user").id));
  if (!manages) return { ok: false, response: c.json({ error: "forbidden", message: "Only project owners and admins, or the computer's owner, can do this." }, 403) };
  return { ok: true, row };
}

/** Tries a login with the server's confirmed key; a pass is remembered. */
async function test(c: Context<AppEnv>, row: SshHostRow) {
  const target = sshTarget(row);
  if (!target) return c.json({ error: "invalid_input", message: "Confirm the server's key first." }, 409);
  const answer = await (await getAgentByName(c.env.RUNNER_AGENT, row.runnerId)).ssh(target);
  if (!answer.ok) return c.json({ error: "runner_failed", message: answer.reason }, 502);
  const passed = answer.result.exitCode === 0;
  if (passed) await createDb(c.env.DB).update(projectSshHosts).set({ testedAt: new Date() }).where(eq(projectSshHosts.id, row.id));
  const updated = await findSshHost(c.env, row.projectId, row.id);
  const [host] = await presentSshHosts(c.env, updated ? [updated] : [], c.get("user").id);
  return c.json({ ok: passed, error: answer.result.error ?? null, detail: answer.result.stderr.trim().split("\n").slice(-3).join("\n").slice(0, 500), host });
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30) || "project"
  );
}
