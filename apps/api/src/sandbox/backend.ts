import { createDb, schema } from "@myrel/db";
import { type AgentStart, CLI_NAMES, CLOUD_RUNNER, CliId, CloudCli, type ProjectWorkspace, type TaskGithub, type TaskModel, TaskTarget, type ThreadRunner } from "@myrel/protocol";
import { claudeModel, type ModelConfig, type RunnerBackend, type TaskSpec } from "@myrel/runner-core";
import { getAgentByName } from "agents";
import { eq } from "drizzle-orm";
import { freshInstallationToken, githubConfigured, installationToken } from "../github/app";
import { listProjectRepos, repoWritable } from "../github/store";
import { getWorkspace, isRunnerReconnecting, listWorkspaces, runnerHasFeature, workspaceClis } from "../runners";

/** The cloud backend: the thread's own container (see sandbox.ts), for a task that works for `principal`. */
export function sandboxBackend(env: Env, threadId: string, principal = ""): RunnerBackend {
  return {
    id: "sandbox",
    unavailable: () =>
      env.SANDBOX
        ? null
        : "This server has no sandbox. Its admin needs to enable Cloudflare Containers (the SANDBOX binding).",
    start: async (spec: TaskSpec, secrets: Record<string, string>) => {
      await env.SANDBOX!.getByName(threadId).run({ threadId, spec, secrets, principal });
    },
    cancel: async (taskId: string) => {
      await env.SANDBOX?.getByName(threadId).cancel(taskId);
    },
  };
}

/**
 * The person's own computer, through myrel-runner (see RunnerAgent): its CLI
 * works in the project's local folder with the person's own login. The runner
 * reports back through `ThreadAgent.taskEvents` like the sandbox does.
 */
export function localBackend(
  env: Env,
  where: { projectId: string; threadId: string; workspace: ProjectWorkspace; agent?: AgentStart; model?: TaskModel; github?: TaskGithub | null },
): RunnerBackend {
  const { projectId, threadId, workspace, agent, model, github } = where;
  return {
    id: "local",
    unavailable: () =>
      workspace.online ? null : "The computer is offline. Ask the person to run `myrel-runner start` on it.",
    start: async (spec: TaskSpec) => {
      const runner = await getAgentByName(env.RUNNER_AGENT, workspace.runnerId);
      const started = await runner.startTask({
        taskId: spec.taskId,
        projectId,
        threadId,
        folder: workspace.path,
        folders: workspace.folders,
        cli: workspace.cli,
        prompt: spec.prompt,
        agent,
        model,
        ...(github && { github }),
      });
      if (!started.ok) throw new Error(started.reason);
    },
    ...localCanceller(env, workspace.runnerId),
  };
}

/** Stops a task on the person's computer, through the runner that is running it. */
export function localCanceller(env: Env, runnerId: string | undefined): Pick<RunnerBackend, "cancel"> {
  return {
    cancel: async (taskId: string) => {
      if (!runnerId) throw new Error("This task is on the person's computer; they can stop it there.");
      const runner = await getAgentByName(env.RUNNER_AGENT, runnerId);
      const result = await runner.cancelTask(taskId);
      if (!result.ok) throw new Error(result.reason);
    },
  };
}

/** The CLI the project's cloud turns run with (the project setting; OpenCode by default). */
export async function projectCloudCli(env: Env, projectId: string): Promise<CloudCli> {
  const [row] = await createDb(env.DB).select({ cloudCli: schema.projects.cloudCli }).from(schema.projects).where(eq(schema.projects.id, projectId));
  return CloudCli.catch("opencode").parse(row?.cloudCli ?? "opencode");
}

/**
 * The harness a cloud turn runs: the CLI asked for when the model suits it, else OpenCode, which
 * takes any model. Claude Code speaks only Anthropic's API, Codex only OpenAI's Responses API.
 * `note` says why the asked-for CLI was not used.
 */
export function cloudHarness(cli: CloudCli, model: Pick<ModelConfig, "kind" | "messages">): { id: "opencode" | "claude-code" | "codex"; title: string; note?: string } {
  if (cli === "claude") {
    if (claudeModel(model)) return { id: "claude-code", title: "Claude Code" };
    return {
      id: "opencode",
      title: "OpenCode",
      note: "This project runs cloud turns with Claude Code, which speaks Anthropic's API: a Claude model, or a provider that serves that API too (Fireworks). This model's provider does not, so this turn runs with OpenCode.",
    };
  }
  if (cli === "codex") {
    if (model.kind === "openai") return { id: "codex", title: "Codex" };
    return { id: "opencode", title: "OpenCode", note: "This project runs cloud turns with Codex, which needs an OpenAI-compatible model; its model is not one, so this turn runs with OpenCode." };
  }
  return { id: "opencode", title: "OpenCode" };
}

export type TaskPlace =
  | { kind: "local"; workspace: ProjectWorkspace }
  | { kind: "cloud" }
  | { kind: "error"; message: string }
  /** The person's computer dropped off moments ago and is most likely coming back: try again shortly. */
  | { kind: "wait"; runnerName: string };

/**
 * Where the project's next task runs, by its task target setting: on the
 * person's computer when the project has a local folder there and the
 * computer is online (auto), or always one place (local, cloud). With local
 * folders on several of their computers, the project's default one if it is
 * theirs, else their oldest.
 *
 * Only for the computer's owner (`requester`, the person the thread works for): a turn runs
 * there as its owner, with their CLI, login and files, so another member of the project, or a
 * thread nobody asked for, works in the cloud instead.
 *
 * `cli`: the CLI the thread was set to run with instead of the folder's. Picked on purpose, so the
 * turn waits for the computer rather than quietly moving to the cloud, and says so when that CLI
 * is gone from it.
 *
 * `runner`: the cloud, or the computer the thread was set to (it waits for that one) or first ran on (it stays
 * there: its CLI session and uncommitted work are there). Without one, when the project's computer
 * for the person is offline, another of theirs in the project that is online (and has the CLI) does.
 *
 * A computer of theirs that went offline only moments ago (a runner restarting for an update, a
 * dropped connection) is waited for (`wait`) rather than replaced by the cloud, whose CLI and
 * session are not the ones the thread was working with.
 */
export async function taskPlace(
  env: Env,
  projectId: string,
  requester: string | null,
  cli?: string | null,
  runner?: ThreadRunner | null,
): Promise<TaskPlace> {
  // A thread set to the cloud (by a member or the coordinator) works there whoever asks.
  if (runner?.id === CLOUD_RUNNER) return { kind: "cloud" };
  const [row] = await createDb(env.DB)
    .select({ taskTarget: schema.projects.taskTarget })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  const target = TaskTarget.catch("auto").parse(row?.taskTarget);
  if (target === "cloud") return { kind: "cloud" };
  const kept = runner ? await getWorkspace(env, projectId, { runnerId: runner.id }) : null;
  if (runner?.by === "person" && !kept) {
    return {
      kind: "error",
      message: "The computer this thread was set to work on is no longer one of this project's. Pick another for it from its message box, then write here again.",
    };
  }
  // Else the requester's own computer when the project has a local folder on one, the default first.
  let workspace = kept ?? (await getWorkspace(env, projectId, { ownerId: requester }));
  const own = workspace && requester ? await ownsComputer(env, workspace.runnerId, requester) : false;
  if (workspace && own && !kept && !workspace.online) {
    const wanted = cli ?? null;
    for (const other of await listWorkspaces(env, projectId, requester!)) {
      if (!other.online || other.runnerId === workspace.runnerId) continue;
      const clis = (await workspaceClis(env, projectId, { runnerId: other.runnerId }))?.clis ?? [];
      if (wanted ? clis.some((c) => c.id === wanted) : CliId.safeParse(other.cli).success) {
        workspace = other;
        break;
      }
    }
  }
  if (workspace && own && !workspace.online && (await isRunnerReconnecting(env, workspace.runnerId))) {
    return { kind: "wait", runnerName: workspace.runnerName };
  }
  if (workspace && !own) {
    if (target === "auto") return { kind: "cloud" };
    return {
      kind: "error",
      message: `This project runs tasks on ${workspace.runnerName}, and only the person whose computer that is can start work there. Ask them, or switch the project to the cloud.`,
    };
  }
  if (workspace && cli) {
    const id = CliId.safeParse(cli);
    const installed = id.success && (await workspaceClis(env, projectId, { runnerId: workspace.runnerId }))?.clis.some((c) => c.id === id.data);
    if (!installed) {
      const name = id.success ? CLI_NAMES[id.data] : cli;
      return {
        kind: "error",
        message: `${name} is not available on ${workspace.runnerName} anymore. Pick another CLI for this thread from its message box, then write here again.`,
      };
    }
    if (!workspace.online) {
      return {
        kind: "error",
        message: `This thread runs with ${CLI_NAMES[id.data!]} on ${workspace.runnerName}, which is offline. Start myrel-runner on it, or pick the project's default for this thread from its message box.`,
      };
    }
    return { kind: "local", workspace: { ...workspace, cli: id.data! } };
  }
  // A folder still set to a CLI Myrel dropped (Gemini CLI) waits for its owner to pick another one.
  if (workspace && !CliId.safeParse(workspace.cli).success) {
    return {
      kind: "error",
      message: `Myrel no longer supports the CLI this project's local folder uses. Pick another CLI for the folder on ${workspace.runnerName} from the project header, then write here again.`,
    };
  }
  if (workspace?.online) return { kind: "local", workspace };
  if (target === "auto") return { kind: "cloud" };
  return {
    kind: "error",
    message: workspace
      ? "This project runs tasks on the person's computer, and it is offline. Ask them to start myrel-runner on it."
      : "This project runs tasks on the person's computer, but no local folder is connected. They can connect one from the project header.",
  };
}

/**
 * The repositories a turn's GitHub token covers: the project's connected ones that whoever connected
 * them can push to (see repoWritable), of the first one's installation (nearly always all of them,
 * as one installation token covers one installation). Null without any.
 */
async function githubScope(env: Env, projectId: string) {
  if (!githubConfigured(env)) return null;
  const all = await listProjectRepos(env.DB, projectId);
  const writable = await Promise.all(all.map((r) => repoWritable(env.DB, projectId, r)));
  const repos = all.filter((_, i) => writable[i]);
  const first = repos[0];
  if (!first) return null;
  const covered = repos.filter((r) => r.installationId === first.installationId);
  return { installationId: first.installationId, repositoryIds: covered.map((r) => r.repoId), repos: covered.map((r) => r.fullName) };
}

/**
 * Pushing, and reading pull requests. Opening and closing them goes through Myrel's tools
 * (open_pull_request, close_pull_request), so gh cannot close, merge or open one past them.
 */
const TURN_GITHUB_PERMISSIONS = { contents: "write", pull_requests: "read", metadata: "read" } as const;

/**
 * The token a cloud agent turn gets for the project's connected repositories, so git and gh work
 * in the sandbox without asking. Null without any.
 */
export async function projectGithubToken(env: Env, projectId: string, runSec: number): Promise<string | null> {
  const scope = await githubScope(env, projectId);
  if (!scope) return null;
  try {
    const minValidMs = Math.min(runSec * 1000 + 5 * 60_000, 55 * 60_000);
    const { installationId, repositoryIds } = scope;
    return (await installationToken(env, installationId, { repositoryIds, permissions: TURN_GITHUB_PERMISSIONS }, minValidMs)).token;
  } catch (err) {
    console.warn("no GitHub token for the project", projectId, err);
    return null;
  }
}

/**
 * The same token for a turn on a person's computer (task.start's `github`): the same repositories and
 * permissions, but only for a runner that can keep it out of files (feature "git-token") and only
 * when the computer is the person's the turn works for. A token of its own, revoked when the turn ends.
 */
export async function localGithubToken(
  env: Env,
  projectId: string,
  runnerId: string,
  requester: string | null,
): Promise<TaskGithub | null> {
  if (!requester || !(await runnerHasFeature(env, runnerId, "git-token")) || !(await ownsComputer(env, runnerId, requester))) return null;
  const scope = await githubScope(env, projectId);
  if (!scope) return null;
  try {
    const { installationId, repositoryIds, repos } = scope;
    const res = await freshInstallationToken(env, installationId, { repositoryIds, permissions: TURN_GITHUB_PERMISSIONS });
    return { token: res.token, expiresAt: new Date(res.expires_at).toISOString(), repos };
  } catch (err) {
    console.warn("no GitHub token for the project", projectId, err);
    return null;
  }
}

/** Whether the paired computer is `userId`'s. */
export async function ownsComputer(env: Env, runnerId: string, userId: string): Promise<boolean> {
  const [row] = await createDb(env.DB)
    .select({ userId: schema.runners.userId })
    .from(schema.runners)
    .where(eq(schema.runners.id, runnerId));
  return row?.userId === userId;
}
