import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_LOCAL_FILE_BYTES, type RunnerFile } from "@myrel/protocol";
import type { RunnerConfig } from "./config";
import { sharedFolder } from "./tasks";
import { listWorktrees } from "./worktrees";

/**
 * Reads a file an agent's message points to, for the web app to show. Only inside the project's
 * folders (each must be shared on this computer) or this thread's worktrees of them, where the
 * thread's CLI did its work. A relative path is looked up in the worktree first, then the folders.
 */
export async function readProjectFile(
  config: RunnerConfig,
  input: { path: string; folders: string[]; threadId?: string },
): Promise<RunnerFile> {
  const roots = await fileRoots(config, input.folders, input.threadId);
  if (!roots.length) throw new Error("None of this project's folders is shared on this computer.");
  const wanted = cleanPath(input.path);
  const candidates = isAbsolute(wanted) ? [wanted] : roots.map((root) => resolve(root, wanted));
  for (const candidate of candidates) {
    const real = await realpath(candidate).catch(() => null);
    // Symlinks are followed first, so one cannot lead outside the folders.
    if (!real || !roots.some((root) => inside(real, root))) continue;
    const info = await stat(real);
    if (!info.isFile()) continue;
    const length = Math.min(info.size, MAX_LOCAL_FILE_BYTES);
    const buffer = Buffer.alloc(length);
    const file = await open(real, "r");
    try {
      await file.read(buffer, 0, length, 0);
    } finally {
      await file.close();
    }
    return { path: real, size: info.size, data: buffer.toString("base64"), truncated: info.size > length };
  }
  throw new Error(`${input.path} is not a file in this project's folders.`);
}

/** The folders a file may be read from: this thread's worktrees of the project's folders, then the folders. */
async function fileRoots(config: RunnerConfig, folders: string[], threadId?: string): Promise<string[]> {
  const shared = (await Promise.all(folders.map((f) => sharedFolder(config, f)))).filter((f) => f !== null);
  const worktrees = threadId ? (await listWorktrees()).filter((w) => w.threadId === threadId) : [];
  const roots: string[] = [];
  for (const folder of shared) {
    for (const w of worktrees) {
      // A shared subfolder of the repository maps to the same subfolder of the worktree (see threadWorktree).
      if (!inside(folder, w.repo)) continue;
      const cwd = await realpath(join(w.path, relative(w.repo, folder))).catch(() => null);
      if (cwd) roots.push(cwd);
    }
  }
  return [...roots, ...shared];
}

/** A link's path without what editors and agents add: file://, %-escapes, :line:col and #L anchors. */
export function cleanPath(path: string): string {
  let p = path.trim();
  if (p.startsWith("file://")) p = p.slice("file://".length);
  try {
    p = decodeURIComponent(p);
  } catch {
    // Not escaped.
  }
  return p.replace(/#L\d+(-L?\d+)?$/, "").replace(/(:\d+){1,2}$/, "");
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}
