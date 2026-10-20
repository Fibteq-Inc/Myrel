import { createDb, schema } from "@altair/db";
import { type CliId, type ProjectWorkspace, type Runner, type RunnerFeature, RunnerInfo } from "@altair/protocol";
import { getAgentByName } from "agents";
import { eq } from "drizzle-orm";

const { runners, projectWorkspaces } = schema;

/** Header the API Worker sets after checking a runner's token. The RunnerAgent trusts it. */
export const RUNNER_ID_HEADER = "x-altair-runner-id";

/** Pairing codes are valid this long. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

// Crockford base32 without look-alikes, so codes can be read aloud and typed.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** An 8-character code shown as XXXX-XXXX (40 bits; short-lived and single-use). */
export function newPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % 32]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Codes are compared case-insensitively and without separators. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function newRunnerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `art_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type RunnerRow = typeof runners.$inferSelect;

export function parseInfo(raw: string | null): RunnerInfo | null {
  if (!raw) return null;
  const parsed = RunnerInfo.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export async function isRunnerOnline(env: Env, runnerId: string): Promise<boolean> {
  const agent = await getAgentByName(env.RUNNER_AGENT, runnerId);
  return agent.isOnline();
}

export async function toRunner(env: Env, row: RunnerRow): Promise<Runner> {
  const info = parseInfo(row.info);
  return {
    id: row.id,
    name: row.name,
    version: info?.version ?? null,
    hostname: info?.hostname ?? "",
    platform: info?.platform ?? "",
    folders: info?.folders ?? [],
    clis: info?.clis ?? [],
    features: info?.features ?? [],
    online: await isRunnerOnline(env, row.id),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The project's local folder, with whether its computer is connected right now. */
export async function getWorkspace(env: Env, projectId: string): Promise<ProjectWorkspace | null> {
  const [row] = await createDb(env.DB)
    .select({
      runnerId: projectWorkspaces.runnerId,
      runnerName: runners.name,
      path: projectWorkspaces.path,
      cli: projectWorkspaces.cli,
    })
    .from(projectWorkspaces)
    .innerJoin(runners, eq(runners.id, projectWorkspaces.runnerId))
    .where(eq(projectWorkspaces.projectId, projectId))
    .limit(1);
  if (!row) return null;
  return { projectId, ...row, cli: row.cli as CliId, online: await isRunnerOnline(env, row.runnerId) };
}

/** Whether a paired computer's altair-runner announced a feature in its last hello. */
export async function runnerHasFeature(env: Env, runnerId: string, feature: RunnerFeature): Promise<boolean> {
  const [row] = await createDb(env.DB).select({ info: runners.info }).from(runners).where(eq(runners.id, runnerId));
  return parseInfo(row?.info ?? null)?.features.includes(feature) ?? false;
}

/** Tells every project working on this runner that its workspace changed, so open clients refresh. */
export async function notifyRunnerProjects(env: Env, runnerId: string): Promise<void> {
  const rows = await createDb(env.DB)
    .select({ projectId: projectWorkspaces.projectId })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.runnerId, runnerId));
  await Promise.all(rows.map((r) => notifyProject(env, r.projectId)));
}

export async function notifyProject(env: Env, projectId: string): Promise<void> {
  const agent = await getAgentByName(env.PROJECT_AGENT, projectId);
  await agent.workspaceChanged();
}
