import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { RunnerConfig } from "../src/config";
import { cleanPath, readProjectFile } from "../src/files";
import { threadWorktree } from "../src/worktrees";

const THREAD = "thr_01JTESTFILES00000000000000";
let root: string;
let config: RunnerConfig;
const text = (f: { data: string }) => Buffer.from(f.data, "base64").toString("utf8");

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "myrel-files-")));
  process.env.MYREL_RUNNER_HOME = join(root, "home");
  const repo = join(root, "repo");
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "# Main checkout\n");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init", "--allow-empty"]);
  await mkdir(join(root, "other"));
  await writeFile(join(root, "other", "notes.txt"), "other folder");
  await writeFile(join(root, "secret.txt"), "not shared");
  await symlink(join(root, "secret.txt"), join(repo, "escape.txt"));
  config = { folders: [{ path: repo }, { path: join(root, "other") }] } as RunnerConfig;
  // The thread's agent worked in its own worktree and left a file there.
  const wt = await threadWorktree(repo, THREAD);
  await writeFile(join(wt!.cwd, "DURUM.md"), "# Durum\n");
});

describe("readProjectFile", () => {
  it("finds a relative path in the thread's worktree first, then in the folders", async () => {
    const repo = join(root, "repo");
    const durum = await readProjectFile(config, { path: "DURUM.md", folders: [repo], threadId: THREAD });
    expect(text(durum)).toBe("# Durum\n");
    expect(durum.truncated).toBe(false);
    expect(text(await readProjectFile(config, { path: "notes.txt", folders: [repo, join(root, "other")] }))).toBe("other folder");
  });

  it("reads an absolute path only inside the folders", async () => {
    const repo = join(root, "repo");
    expect(text(await readProjectFile(config, { path: `file://${join(root, "other", "notes.txt")}:3`, folders: [join(root, "other")] }))).toBe(
      "other folder",
    );
    await expect(readProjectFile(config, { path: join(root, "secret.txt"), folders: [repo] })).rejects.toThrow("not a file");
    await expect(readProjectFile(config, { path: "escape.txt", folders: [repo] })).rejects.toThrow("not a file");
    await expect(readProjectFile(config, { path: "../secret.txt", folders: [repo] })).rejects.toThrow("not a file");
  });

  it("refuses folders that are not shared", async () => {
    await expect(readProjectFile(config, { path: "secret.txt", folders: [root] })).rejects.toThrow("shared");
  });
});

describe("cleanPath", () => {
  it("drops what editors add to file links", () => {
    expect(cleanPath("file:///a/b%20c.md#L10")).toBe("/a/b c.md");
    expect(cleanPath("src/app.ts:12:4")).toBe("src/app.ts");
  });
});
