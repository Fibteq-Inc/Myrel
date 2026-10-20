import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToServer } from "@altair/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { type RunnerConfig, SessionStore } from "../src/config";
import { TaskRunner } from "../src/tasks";
import { listWorktrees, pruneWorktrees, removeWorktree, threadWorktree } from "../src/worktrees";

const A = "thr_01JTEST0000000000000000AAAA";
const B = "thr_01JTEST0000000000000000BBBB";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();

let home: string;
let repo: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "altair-wt-"));
  // Behind a symlink, like the temp folder on macOS (/var is /private/var).
  await mkdir(join(home, "real-runner"));
  await symlink(join(home, "real-runner"), join(home, ".runner"));
  process.env.ALTAIR_RUNNER_HOME = join(home, ".runner");
  repo = join(home, "repo");
  await mkdir(join(repo, "web"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "web", "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  repo = await realpath(repo);
});

describe.skipIf(process.platform === "win32")("thread worktrees", () => {
  it("gives each thread its own worktree and branch, reused by its later tasks", async () => {
    const a = await threadWorktree(repo, A);
    const b = await threadWorktree(repo, B);
    expect(a?.created).toBe(true);
    expect(a?.worktree.branch).toBe("altair/thr-000000aaaa");
    expect(b?.worktree.path).not.toBe(a?.worktree.path);
    expect(git(a!.cwd, "branch", "--show-current")).toBe("altair/thr-000000aaaa");
    // The main checkout stays on its branch.
    expect(git(repo, "branch", "--show-current")).toBe("main");

    const again = await threadWorktree(repo, A);
    expect(again).toMatchObject({ created: false, cwd: a!.cwd });
    expect(await listWorktrees()).toHaveLength(2);
  });

  it("maps a shared subfolder to the same subfolder of the worktree", async () => {
    const w = await threadWorktree(join(repo, "web"), A);
    expect(w?.cwd).toBe(join(w!.worktree.path, "web"));
  });

  it("leaves folders that are not git repositories alone", async () => {
    const plain = join(home, "plain");
    await mkdir(plain);
    expect(await threadWorktree(plain, A)).toBeNull();
  });

  it("cleans up only idle, clean worktrees whose branch is merged", async () => {
    const merged = (await threadWorktree(repo, A))!.worktree;
    const unmerged = (await threadWorktree(repo, B))!.worktree;
    await writeFile(join(unmerged.path, "b.txt"), "b\n");
    git(unmerged.path, "add", ".");
    git(unmerged.path, "commit", "-qm", "work");

    expect(await pruneWorktrees()).toEqual([]); // used just now
    const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
    expect((await pruneWorktrees(() => false, later)).map((w) => w.branch)).toEqual([merged.branch]);
    expect(git(repo, "branch", "--list", merged.branch)).toBe("");

    // Merging it lets it go too; uncommitted changes would keep it.
    git(repo, "merge", "-q", unmerged.branch);
    await writeFile(join(unmerged.path, "c.txt"), "c\n");
    expect(await pruneWorktrees(() => false, later)).toEqual([]);
    await expect(removeWorktree(unmerged)).rejects.toThrow(/uncommitted changes/);
    await removeWorktree(unmerged, { force: true });
    expect(await listWorktrees()).toEqual([]);
  });

  it("runs a thread's task in its worktree and says where the work is", async () => {
    const bin = join(home, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "claude"),
      `#!/bin/sh\nread prompt\nprintf '{"type":"result","subtype":"success","is_error":false,"result":"in %s on %s"}\\n' "$(pwd)" "$(git branch --show-current)"\n`,
    );
    await chmod(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const config: RunnerConfig = { folders: [{ path: repo, name: "repo" }], access: "edit" };
    const run = async (c: RunnerConfig) => {
      const frames: RunnerToServer[] = [];
      const runner = new TaskRunner({ config: () => c, sessions: new SessionStore() });
      runner.setSender((f) => frames.push(f));
      await runner.start({ type: "task.start", taskId: "task_01JTEST0000000000000000000", threadId: A, folder: repo, cli: "claude", prompt: "x" });
      return (frames.at(-1) as { result: string }).result;
    };

    const result = await run(config);
    const [w] = await listWorktrees();
    expect(result).toContain(`in ${w!.path} on altair/thr-000000aaaa`);
    expect(result).toContain(`(myrel-runner: worked on branch altair/thr-000000aaaa in ${w!.path}, a git worktree of ${repo}.)`);
    // Turned off, or read-only: the shared folder itself.
    expect(await run({ ...config, worktrees: false })).toBe(`in ${repo} on main`);
    expect(await run({ ...config, access: "read" })).toBe(`in ${repo} on main`);
  });
});
