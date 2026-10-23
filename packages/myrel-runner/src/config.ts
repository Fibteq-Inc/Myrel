import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { CliId, RunnerAccess, RunnerFolder } from "@myrel/protocol";

/**
 * What the CLI may do without asking. read: look only. edit (default): change files, but not run
 * arbitrary commands. auto: Claude Code's auto mode, where it decides itself which steps are safe and
 * asks (through Myrel) about the rest; other CLIs treat it like edit. full: anything, no prompts.
 */
export type Access = RunnerAccess;

export type RunnerConfig = {
  /** Origin of the Myrel server, e.g. https://myrel.example.com */
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
  /** Install newer versions by itself when no task is running (background runner only). Default off. */
  autoUpdate?: boolean;
  /** false: settings cannot be changed from Myrel, only here. Default on. */
  remoteSettings?: boolean;
};

/** ~/.myrel-runner, or MYREL_RUNNER_HOME. Holds config.json (mode 600) and sessions.json. */
export function runnerHome(): string {
  return process.env.MYREL_RUNNER_HOME || join(homedir(), ".myrel-runner");
}

export const configPath = () => join(runnerHome(), "config.json");

/**
 * The saved config. MYREL_SERVER and MYREL_RUNNER_TOKEN override the saved pairing, so an
 * app that paired the runner itself (the desktop app) can start it without writing the token to disk.
 */
export async function loadConfig(): Promise<RunnerConfig> {
  const raw = await readJson<Partial<RunnerConfig>>(configPath());
  const config: RunnerConfig = { folders: [], access: "edit", ...raw };
  if (process.env.MYREL_SERVER) config.server = process.env.MYREL_SERVER;
  if (process.env.MYREL_RUNNER_TOKEN) config.token = process.env.MYREL_RUNNER_TOKEN;
  return config;
}

/** The runner's own credentials in its environment, which no process it starts may inherit. */
const RUNNER_SECRETS = ["MYREL_RUNNER_TOKEN"];

/**
 * The environment for a process the runner starts (an agent CLI, git, a version check): the runner's
 * own, minus its device token. A task runs repository code (tests, builds, scripts) that must never
 * be able to read the token and connect as this computer.
 */
export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of RUNNER_SECRETS) delete env[key];
  return env;
}

export async function saveConfig(config: RunnerConfig): Promise<void> {
  // Never persist a token that only came from the environment.
  const saved = { ...config };
  if (process.env.MYREL_RUNNER_TOKEN && saved.token === process.env.MYREL_RUNNER_TOKEN) {
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
/** A thread's CLI session, and the task whose turn it last ran. */
export type StoredSession = { id: string; task?: string };

export class SessionStore {
  constructor(private readonly path = join(runnerHome(), "sessions.json")) {}

  async get(threadId: string, cli: CliId = "claude"): Promise<StoredSession | undefined> {
    const value = (await readJson<Record<string, string | StoredSession>>(this.path))?.[sessionKey(threadId, cli)];
    // Runners before 0.11.1 kept only the id.
    return typeof value === "string" ? { id: value } : value;
  }

  async set(threadId: string, cli: CliId, session: StoredSession): Promise<void> {
    const all = (await readJson<Record<string, string | StoredSession>>(this.path)) ?? {};
    all[sessionKey(threadId, cli)] = session;
    await writeJson(this.path, all);
  }
}

/** Claude Code's sessions keep the bare thread id they always had. */
const sessionKey = (threadId: string, cli: CliId) => (cli === "claude" ? threadId : `${cli}:${threadId}`);

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
