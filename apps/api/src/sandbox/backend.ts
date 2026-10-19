import type { ProjectWorkspace } from "@altair/protocol";
import type { RunnerBackend, TaskSpec } from "@altair/runner-core";
import { getAgentByName } from "agents";
import { githubConfigured } from "../github/app";
import { projectRepoToken } from "../github/store";

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
 * The person's own computer, through altair-runner (see RunnerAgent): its CLI
 * works in the project's local folder with the person's own login. The runner
 * reports back through `ThreadAgent.taskEvents` like the sandbox does.
 */
export function localBackend(
  env: Env,
  where: { projectId: string; threadId: string; workspace: ProjectWorkspace },
): RunnerBackend {
  const { projectId, threadId, workspace } = where;
  return {
    id: "local",
    unavailable: () =>
      workspace.online ? null : "The computer is offline. Ask the person to run `altair-runner start` on it.",
    start: async (spec: TaskSpec) => {
      const runner = await getAgentByName(env.RUNNER_AGENT, workspace.runnerId);
      const started = await runner.startTask({
        taskId: spec.taskId,
        projectId,
        threadId,
        folder: workspace.path,
        cli: workspace.cli,
        prompt: spec.prompt,
      });
      if (!started.ok) throw new Error(started.reason);
    },
    cancel: async () => {
      throw new Error("A task on the person's computer cannot be stopped from here yet. They can stop it there.");
    },
  };
}

/**
 * The token a task gets for cloning, pushing and opening pull requests: a
 * GitHub App installation token limited to that one repository, which must be
 * connected to the project. Null otherwise; public repositories still clone
 * without it. GitHub's tokens last an hour, so a task gets one that is valid
 * for as much of its run as possible.
 */
export async function repoToken(env: Env, projectId: string, repoUrl: string, runSec: number): Promise<string | null> {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)\.git$/.exec(repoUrl);
  if (!match || !githubConfigured(env)) return null;
  const minValidMs = Math.min(runSec * 1000 + 5 * 60_000, 55 * 60_000);
  const permissions = { contents: "write", pull_requests: "write", metadata: "read" } as const;
  try {
    return (await projectRepoToken(env, projectId, match[1]!, permissions, minValidMs)).token;
  } catch (err) {
    console.warn("no repository token", repoUrl, err);
    return null;
  }
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
