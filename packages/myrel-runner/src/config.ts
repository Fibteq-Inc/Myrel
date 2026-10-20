import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { RunnerFolder } from "@altair/protocol";

/**
 * How much the CLI may do on its own in a shared folder.
 * read: look only. edit (default): change files, but not run arbitrary commands. full: anything, no prompts.
 */
export type Access = "read" | "edit" | "full";

export type RunnerConfig = {
  /** Origin of the Myrel server, e.g. https://altair.example.com */
  server?: string;
  runnerId?: string;
  /** The runner's secret. Only ever sent to `server`. */
  token?: string;
  folders: RunnerFolder[];
  access: Access;
  /**
   * Run each thread's tasks in its own git worktree and branch when the folder is a git
   * repository, so threads working at the same time never touch each other's files. Default on.
   */
  worktrees?: boolean;
};

/** ~/.altair-runner, or ALTAIR_RUNNER_HOME. Holds config.json (mode 600) and sessions.json. */
export function runnerHome(): string {
  return process.env.ALTAIR_RUNNER_HOME || join(homedir(), ".altair-runner");
}

export const configPath = () => join(runnerHome(), "config.json");

/**
 * The saved config. ALTAIR_SERVER and ALTAIR_RUNNER_TOKEN override the saved pairing, so an
 * app that paired the runner itself (the desktop app) can start it without writing the token to disk.
 */
export async function loadConfig(): Promise<RunnerConfig> {
  const raw = await readJson<Partial<RunnerConfig>>(configPath());
  const config: RunnerConfig = { folders: [], access: "edit", ...raw };
  if (process.env.ALTAIR_SERVER) config.server = process.env.ALTAIR_SERVER;
  if (process.env.ALTAIR_RUNNER_TOKEN) config.token = process.env.ALTAIR_RUNNER_TOKEN;
  return config;
}

export async function saveConfig(config: RunnerConfig): Promise<void> {
  // Never persist a token that only came from the environment.
  const saved = { ...config };
  if (process.env.ALTAIR_RUNNER_TOKEN && saved.token === process.env.ALTAIR_RUNNER_TOKEN) {
    saved.token = (await readJson<Partial<RunnerConfig>>(configPath()))?.token;
  }
  await writeJson(configPath(), saved);
}

/** Adds a folder (resolved to an absolute path). Returns false if it was already shared. */
export function shareFolder(config: RunnerConfig, folder: string): boolean {
  const path = resolve(folder);
  if (config.folders.some((f) => f.path === path)) return false;
  config.folders.push({ path, name: basename(path) || path });
  return true;
}

export function unshareFolder(config: RunnerConfig, folder: string): boolean {
  const path = resolve(folder);
  const before = config.folders.length;
  config.folders = config.folders.filter((f) => f.path !== path);
  return config.folders.length !== before;
}

/** Per-thread CLI session ids, so later tasks in a thread continue the same conversation. */
export class SessionStore {
  constructor(private readonly path = join(runnerHome(), "sessions.json")) {}

  async get(threadId: string): Promise<string | undefined> {
    return (await readJson<Record<string, string>>(this.path))?.[threadId];
  }

  async set(threadId: string, sessionId: string): Promise<void> {
    const all = (await readJson<Record<string, string>>(this.path)) ?? {};
    all[threadId] = sessionId;
    await writeJson(this.path, all);
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Written to a temp file and renamed, readable by the owner only: it can hold the runner token. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(runnerHome(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}
