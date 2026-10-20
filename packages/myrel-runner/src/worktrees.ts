import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import { readJson, runnerHome, writeJson } from "./config";

const run = promisify(execFile);

/** Worktrees idle this long whose work is merged are removed by `pruneWorktrees`. */
const IDLE_MS = 24 * 60 * 60 * 1000;

/** A thread's own checkout of a shared git repository, on its own branch. */
export type Worktree = {
  threadId: string;
  /** The shared repository's main checkout. */
  repo: string;
  /** The worktree folder, under ~/.myrel-runner/worktrees. */
  path: string;
  branch: string;
  lastUsed: number;
};

const indexPath = () => join(runnerHome(), "worktrees.json");
const git = (cwd: string, args: string[]) => run("git", ["-C", cwd, ...args], { maxBuffer: 4 * 1024 * 1024 });

export async function listWorktrees(): Promise<Worktree[]> {
  return (await readJson<Worktree[]>(indexPath())) ?? [];
}

async function saveWorktrees(all: Worktree[]) {
  await writeJson(indexPath(), all);
}

/** `myrel/thr-<last 10 characters of the thread id>`, unique enough within one repository. */
export function branchFor(threadId: string): string {
  return `myrel/thr-${threadId.slice(-10).toLowerCase()}`;
}

/**
 * Where a thread's task should run in `folder`, so two threads working in the
 * same repository at once never edit the same files or switch each other's
 * branch: each thread gets a git worktree on its own branch, made from the
 * repository's current commit on its first task and reused after that.
 * Uncommitted changes in the main checkout are not carried over.
 *
 * Returns null when `folder` is not in a git repository with at least one
 * commit (or git is missing): the task then runs in `folder` itself.
 */
export async function threadWorktree(
  folder: string,
  threadId: string,
): Promise<{ cwd: string; worktree: Worktree; created: boolean } | null> {
  const root = await git(folder, ["rev-parse", "--show-toplevel"])
    .then((r) => realpath(r.stdout.trim()))
    .catch(() => null);
  if (!root) return null;
  if (!(await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => null))) return null;

  const all = await listWorktrees();
  let worktree = all.find((w) => w.repo === root && w.threadId === threadId);
  let created = false;
  if (!worktree || !(await stat(worktree.path).catch(() => null))) {
    const id = createHash("sha256").update(root).digest("hex").slice(0, 8);
    const parent = join(runnerHome(), "worktrees", `${basename(root)}-${id}`);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    // The real path, as the CLI sees its folder (on macOS the temp folder /var is /private/var).
    const path = join(await realpath(parent), threadId.slice(-10).toLowerCase());
    const branch = branchFor(threadId);
    await git(root, ["worktree", "prune"]).catch(() => {});
    const exists = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => null);
    // Continues the thread's branch if a removed worktree left it behind.
    await git(root, exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"]);
    worktree = { threadId, repo: root, path, branch, lastUsed: Date.now() };
    created = true;
  }
  worktree.lastUsed = Date.now();
  await saveWorktrees([...all.filter((w) => !(w.repo === root && w.threadId === threadId)), worktree]);
  // A shared subfolder of the repository maps to the same subfolder of the worktree.
  return { cwd: join(worktree.path, relative(root, await realpath(folder))), worktree, created };
}

/** Whether the worktree has uncommitted changes, or its branch has commits the main checkout's branch lacks. */
export async function worktreeState(w: Worktree): Promise<{ missing: boolean; dirty: boolean; merged: boolean }> {
  if (!(await stat(w.path).catch(() => null))) return { missing: true, dirty: false, merged: true };
  const status = await git(w.path, ["status", "--porcelain"]).catch(() => null);
  const merged = await git(w.repo, ["merge-base", "--is-ancestor", w.branch, "HEAD"])
    .then(() => true)
    .catch(() => false);
  return { missing: false, dirty: status === null || status.stdout.trim() !== "", merged };
}

/**
 * Removes a thread's worktree and, when its work is merged, its branch.
 * Refuses when it has uncommitted changes, unless `force`.
 */
export async function removeWorktree(w: Worktree, { force = false } = {}): Promise<void> {
  const state = await worktreeState(w);
  if (state.dirty && !force) throw new Error(`${w.path} has uncommitted changes. Commit them, or remove it with --force.`);
  if (!state.missing) await git(w.repo, ["worktree", "remove", ...(force ? ["--force"] : []), w.path]);
  await git(w.repo, ["worktree", "prune"]).catch(() => {});
  // -d keeps a branch whose commits are not merged anywhere yet.
  if (state.merged) await git(w.repo, ["branch", "-d", w.branch]).catch(() => {});
  await saveWorktrees((await listWorktrees()).filter((x) => x.path !== w.path));
}

/**
 * Cleans up after finished threads: removes worktrees idle for a day that
 * have no uncommitted changes and whose branch is merged into the main
 * checkout's branch. Anything else is kept. Returns what was removed.
 */
export async function pruneWorktrees(busy: (w: Worktree) => boolean = () => false, now = Date.now()): Promise<Worktree[]> {
  const removed: Worktree[] = [];
  for (const w of await listWorktrees()) {
    if (busy(w) || now - w.lastUsed < IDLE_MS) continue;
    const state = await worktreeState(w).catch(() => null);
    if (!state || state.dirty || !state.merged) continue;
    await removeWorktree(w)
      .then(() => removed.push(w))
      .catch(() => {});
  }
  return removed;
}
