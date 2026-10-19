import type { ThreadFiles } from "@altair/protocol";

/**
 * A thread's workspace: a Cloudflare Artifacts repository the sandbox saves
 * every task's work to, so the next task continues from it even after the
 * container went to sleep and lost its disk. One per thread, created on the
 * thread's first task.
 */
export type Workspace = { remote: string; token: string };

/** Name of a thread's repository (letters, digits, dots, hyphens and underscores). */
export function workspaceName(threadId: string): string {
  return `thread-${threadId}`;
}

/**
 * The thread's workspace remote and a write token that lives as long as one
 * task may. Null when the server has no Artifacts binding, or Artifacts fails:
 * tasks then run without saving, as before.
 */
export async function threadWorkspace(env: Env, threadId: string, ttlSec: number): Promise<Workspace | null> {
  // Self-hosted servers may leave the binding out.
  const artifacts = (env as Partial<Env>).WORKSPACES;
  if (!artifacts) return null;
  const name = workspaceName(threadId);
  try {
    let repo: ArtifactsRepo;
    try {
      repo = await artifacts.get(name);
    } catch (err) {
      if (errorCode(err) !== "NOT_FOUND") throw err;
      await artifacts.create(name, { description: `Altair thread ${threadId}` });
      repo = await artifacts.get(name);
    }
    try {
      const [info, token] = await Promise.all([repo.info(), repo.createToken("write", Math.max(60, ttlSec))]);
      return { remote: info.remote, token: bearer(token.plaintext) };
    } finally {
      repo[Symbol.dispose]?.();
    }
  } catch (err) {
    console.warn("thread workspace unavailable", name, err);
    return null;
  }
}

/** Tokens come as `art_v1_<hex>?expires=<unix seconds>`; git sends only the part before `?`. */
function bearer(plaintext: string): string {
  return plaintext.split("?")[0]!;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

/** What a thread's workspace holds at one branch: its history and one folder or file. */
export type WorkspaceView = ThreadFiles;

/** Text files larger than this are cut; binary files are not shown. */
const MAX_FILE_BYTES = 200_000;

/**
 * Reads the thread's workspace without starting a sandbox: the last commits of
 * `ref` and the folder or file at `path` (repository-relative, "" for the root).
 * Null when the server has no workspaces or the thread never saved any work.
 */
export async function readWorkspace(env: Env, threadId: string, ref: string, path = ""): Promise<WorkspaceView | null> {
  const artifacts = (env as Partial<Env>).WORKSPACES;
  if (!artifacts) return null;
  let repo: ArtifactsRepo;
  try {
    repo = await artifacts.get(workspaceName(threadId));
  } catch (err) {
    if (errorCode(err) === "NOT_FOUND") return null;
    throw err;
  }
  try {
    const log = await repo.log({ ref, limit: 20 });
    const head = log[0];
    if (!head) return null;
    const commits = log.map((c) => ({ hash: c.hash, message: c.message, at: new Date(c.committedAt * 1000).toISOString() }));
    const clean = path.split("/").filter((p) => p && p !== "." && p !== "..");
    // Walk the tree down to the folder or file at `path`.
    let tree = await repo.readTree(head.treeHash);
    for (let i = 0; i < clean.length; i++) {
      const entry = tree?.find((e) => e.name === clean[i]);
      if (!entry) return { ref, commits, entries: null, file: null };
      if (entry.type === "tree") {
        tree = await repo.readTree(entry.hash);
        continue;
      }
      if (i !== clean.length - 1 || (entry.type !== "blob" && entry.type !== "exec")) return { ref, commits, entries: null, file: null };
      const blob = await repo.readBlob(entry.hash);
      if (!blob) return { ref, commits, entries: null, file: null };
      const bytes = new Uint8Array(await blob.slice(0, MAX_FILE_BYTES).arrayBuffer());
      const binary = bytes.includes(0);
      const text = binary ? null : new TextDecoder().decode(bytes);
      return { ref, commits, entries: null, file: { path: clean.join("/"), text, size: blob.size, truncated: blob.size > MAX_FILE_BYTES } };
    }
    const prefix = clean.length ? `${clean.join("/")}/` : "";
    const entries = (tree ?? [])
      .filter((e) => e.type === "tree" || e.type === "blob" || e.type === "exec")
      .map((e) => ({ name: e.name, path: `${prefix}${e.name}`, type: e.type === "tree" ? ("folder" as const) : ("file" as const) }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1));
    return { ref, commits, entries, file: null };
  } finally {
    repo[Symbol.dispose]?.();
  }
}
