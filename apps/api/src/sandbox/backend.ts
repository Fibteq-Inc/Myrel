import type { RunnerBackend, TaskSpec } from "@altair/runner-core";

/** The cloud backend: the thread's own container (see sandbox.ts). */
export function sandboxBackend(env: Env, threadId: string): RunnerBackend {
  return {
    id: "sandbox",
    unavailable: () =>
      env.SANDBOX
        ? null
        : "This server has no sandbox. Its admin needs to enable Cloudflare Containers (the SANDBOX binding).",
    start: async (spec: TaskSpec, secrets: Record<string, string>) => {
      await env.SANDBOX!.getByName(threadId).run({ threadId, spec, secrets });
    },
    cancel: async (taskId: string) => {
      await env.SANDBOX?.getByName(threadId).cancel(taskId);
    },
  };
}

/**
 * The token a task gets for cloning, pushing and opening pull requests: a
 * GitHub App installation token limited to that one project repository.
 * Null until the project's GitHub connection provides one; public
 * repositories still clone without it.
 */
export async function repoToken(_env: Env, _projectId: string, _repoUrl: string): Promise<string | null> {
  return null;
}

/** Accepts `owner/name`, a github.com URL or any HTTPS git URL; returns an HTTPS clone URL. */
export function normalizeRepoUrl(repo: string): string | null {
  const trimmed = repo.trim().replace(/\/+$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return `https://github.com/${trimmed.replace(/\.git$/, "")}.git`;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.hostname === "github.com") {
      const [owner, name] = url.pathname.split("/").filter(Boolean);
      return owner && name ? `https://github.com/${owner}/${name.replace(/\.git$/, "")}.git` : null;
    }
    return url.href;
  } catch {
    return null;
  }
}
