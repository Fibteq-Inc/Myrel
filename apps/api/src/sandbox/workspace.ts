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
