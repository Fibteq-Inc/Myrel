import { createDb, schema } from "@myrel/db";
import { type CliId, MAX_WORKSPACE_FOLDERS, type ProjectWorkspace, type Runner, type RunnerCli, type RunnerFeature, RunnerInfo } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { eq } from "drizzle-orm";

const { runners, projectWorkspaces } = schema;

/** Header the API Worker sets after checking a runner's token. The RunnerAgent trusts it. */
export const RUNNER_ID_HEADER = "x-myrel-runner-id";

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
    ...(info?.settings && { settings: info.settings }),
    ...(info?.updates && { updates: info.updates }),
    ...(info?.update && { update: info.update }),
    online: await isRunnerOnline(env, row.id),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** How long the newest myrel-runner version from npm is remembered (a failed lookup: a few minutes). */
const LATEST_TTL_MS = 60 * 60 * 1000;
const LATEST_RETRY_MS = 5 * 60 * 1000;
let latest: { version: string | null; until: number } | null = null;

/** The newest myrel-runner on npm, for the "update available" button; null when npm cannot be reached. */
export async function latestRunnerVersion(now = Date.now()): Promise<string | null> {
  if (latest && latest.until > now) return latest.version;
  let version: string | null = null;
  try {
    const res = await fetch("https://registry.npmjs.org/@fibteq%2Fmyrel-runner/latest", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    const body = res.ok ? ((await res.json()) as { version?: unknown }) : null;
    if (typeof body?.version === "string" && /^\d+\.\d+\.\d+$/.test(body.version)) version = body.version;
  } catch {
    // Shown without the button until the next try.
  }
  latest = { version, until: now + (version ? LATEST_TTL_MS : LATEST_RETRY_MS) };
  return version;
}

/** The project's local folder, with whether its computer is connected right now. */
export async function getWorkspace(env: Env, projectId: string): Promise<ProjectWorkspace | null> {
  const [row] = await createDb(env.DB)
    .select({
      runnerId: projectWorkspaces.runnerId,
      runnerName: runners.name,
      path: projectWorkspaces.path,
      folders: projectWorkspaces.folders,
      cli: projectWorkspaces.cli,
    })
    .from(projectWorkspaces)
    .innerJoin(runners, eq(runners.id, projectWorkspaces.runnerId))
    .where(eq(projectWorkspaces.projectId, projectId))
    .limit(1);
  if (!row) return null;
  return {
    projectId,
    ...row,
    folders: parseFolders(row.folders),
    cli: row.cli as CliId,
    online: await isRunnerOnline(env, row.runnerId),
  };
}

/**
 * The CLIs installed on the computer of the project's local folder, as it last reported them (with
 * their limits), and whose computer it is. Null without a local folder.
 */
export async function workspaceClis(env: Env, projectId: string): Promise<{ ownerId: string; clis: RunnerCli[] } | null> {
  const [row] = await createDb(env.DB)
    .select({ ownerId: runners.userId, info: runners.info })
    .from(projectWorkspaces)
    .innerJoin(runners, eq(runners.id, projectWorkspaces.runnerId))
    .where(eq(projectWorkspaces.projectId, projectId))
    .limit(1);
  return row ? { ownerId: row.ownerId, clis: parseInfo(row.info)?.clis ?? [] } : null;
}

/** A workspace's other folders, from their JSON column. */
export function parseFolders(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Adds a folder to the project's other folders, or takes one out. The main folder is never one
 * of them. Returns false when the project has no local folder. Callable from routes and agents.
 */
export async function setWorkspaceFolder(env: Env, projectId: string, path: string, add: boolean): Promise<boolean> {
  const db = createDb(env.DB);
  const [row] = await db
    .select({ path: projectWorkspaces.path, folders: projectWorkspaces.folders })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.projectId, projectId));
  if (!row) return false;
  const others = parseFolders(row.folders).filter((f) => f !== path);
  const folders = add && path !== row.path ? [...others, path].slice(-MAX_WORKSPACE_FOLDERS) : others;
  await db
    .update(projectWorkspaces)
    .set({ folders: JSON.stringify(folders), updatedAt: new Date() })
    .where(eq(projectWorkspaces.projectId, projectId));
  await notifyProject(env, projectId);
  return true;
}

/** Whether a paired computer's myrel-runner announced a feature in its last hello. */
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
