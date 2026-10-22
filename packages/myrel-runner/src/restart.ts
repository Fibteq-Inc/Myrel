import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runnerHome } from "./config";

/** An interrupted task older than this is not reported again: the server has given it up by then. */
const INTERRUPTED_MAX_AGE_MS = 60 * 60 * 1000;

const interruptedPath = () => join(runnerHome(), "interrupted.json");
const statePath = () => join(runnerHome(), "running.json");

type Interrupted = { taskId: string; at: number };

/**
 * Notes the tasks this runner stopped as it shut down, for the next one to report as interrupted.
 * Synchronous: it runs while the process is exiting.
 */
export function saveInterrupted(taskIds: string[], now = Date.now()): void {
  if (!taskIds.length) return;
  const all = [...readInterrupted(now), ...taskIds.map((taskId) => ({ taskId, at: now }))];
  write(interruptedPath(), all);
}

/** The tasks the previous runner stopped, removed from disk: each is reported once per process. */
export function takeInterrupted(now = Date.now()): string[] {
  const ids = [...new Set(readInterrupted(now).map((t) => t.taskId))];
  rmSync(interruptedPath(), { force: true });
  return ids;
}

function readInterrupted(now: number): Interrupted[] {
  const all = read<Interrupted[]>(interruptedPath());
  return Array.isArray(all) ? all.filter((t) => typeof t?.taskId === "string" && now - t.at < INTERRUPTED_MAX_AGE_MS) : [];
}

/** Tells `myrel-runner update` (another process) which tasks this runner is running. */
export function writeRunning(running: string[]): void {
  try {
    write(statePath(), { pid: process.pid, running });
  } catch {
    // Only `update` reads it, to wait for the tasks; never worth failing a task over.
  }
}

/** The tasks the background runner is running now; empty when it is not running. */
export function readRunning(): string[] {
  const state = read<{ pid?: number; running?: string[] }>(statePath());
  if (!state?.pid || !Array.isArray(state.running) || !alive(state.pid)) return [];
  return state.running;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is only someone else's.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function read<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function write(path: string, value: unknown) {
  mkdirSync(runnerHome(), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
