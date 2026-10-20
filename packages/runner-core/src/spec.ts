import { z } from "zod";

/**
 * The coding harness a task runs. Each one is a CLI agent that edits code and
 * runs commands on its own; Myrel only starts it and reads its output.
 * - opencode: OpenCode, any model (the default, since Myrel is multi-model).
 * - claude-code: Claude Code (`claude -p`), Claude models only.
 * - shell: no model; the prompt is a bash script. For running tests or a build.
 */
export const HarnessId = z.enum(["opencode", "claude-code", "shell"]);
export type HarnessId = z.infer<typeof HarnessId>;

/** How the harness reaches its model. The key itself is a secret and travels separately. */
export const ModelConfig = z.object({
  /** Wire format: OpenAI-compatible chat or Anthropic messages. */
  kind: z.enum(["openai", "anthropic"]),
  /** Myrel's provider id, e.g. "fireworks". */
  provider: z.string().min(1),
  /** The provider's model id, e.g. "accounts/fireworks/models/kimi-k2p6". */
  id: z.string().min(1),
  baseUrl: z.string().url().optional(),
  /** The model reads images, so the harness may show it screenshots and photos. */
  images: z.boolean().optional(),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const RepoSpec = z.object({
  /** HTTPS clone URL, e.g. https://github.com/acme/app.git */
  url: z.string().url(),
  /** Branch to start from. Empty = the repository's default branch. */
  baseBranch: z.string().max(200).optional(),
  /** Branch to work on. Empty = a new branch named after the task. Reuse a PR's branch to update it. */
  branch: z.string().max(200).optional(),
});
export type RepoSpec = z.infer<typeof RepoSpec>;

/**
 * Where a task's work is kept between tasks: a git remote the runner pushes
 * every result to, and the next task starts from (a Cloudflare Artifacts repo
 * per thread). Its access token is a secret and travels separately.
 */
export const WorkspaceSpec = z.object({
  /** HTTPS git remote. */
  remote: z.string().url(),
});
export type WorkspaceSpec = z.infer<typeof WorkspaceSpec>;

/** One unit of work handed to a runner. Stored with the task, so it holds no secrets. */
export const TaskSpec = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1).max(120),
  prompt: z.string().min(1).max(100_000),
  harness: HarnessId.default("opencode"),
  repo: RepoSpec.optional(),
  workspace: WorkspaceSpec.optional(),
  /** Commit, push and open (or update) a pull request when the harness finishes with changes. */
  openPr: z.boolean().default(false),
  model: ModelConfig.optional(),
  /**
   * The thread's MCP endpoint, when the harness runs as the thread's agent and talks to people
   * through Myrel's tools. Its bearer token is a secret (MYREL_MCP_TOKEN).
   */
  mcp: z.object({ url: z.string().url() }).optional(),
  timeoutSec: z
    .number()
    .int()
    .positive()
    .max(4 * 3600)
    .default(1800),
});
export type TaskSpec = z.infer<typeof TaskSpec>;
export type TaskSpecInput = z.input<typeof TaskSpec>;

/** Steps every task goes through, shown as the first lines of the thread's checklist. */
export const Phase = z.enum(["prepare", "clone", "agent", "save", "publish"]);
export type Phase = z.infer<typeof Phase>;

export const TodoStatus = z.enum(["pending", "in_progress", "done"]);
export type TodoStatus = z.infer<typeof TodoStatus>;

/**
 * What a runner reports while a task runs. Every runner (the cloud sandbox,
 * the local `myrel-runner`) speaks this, whatever harness it starts.
 */
export const RunnerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("phase"),
    phase: Phase,
    state: z.enum(["started", "done", "failed", "skipped"]),
    detail: z.string().max(500).optional(),
  }),
  /** The harness's own plan (OpenCode's todowrite, Claude Code's TodoWrite). Replaces the previous list. */
  z.object({
    type: z.literal("todos"),
    items: z.array(z.object({ text: z.string().max(300), status: TodoStatus })).max(50),
  }),
  /** Terminal output. */
  z.object({ type: z.literal("log"), stream: z.enum(["stdout", "stderr", "system"]), text: z.string() }),
  /** The harness used a tool (edited a file, ran a command). */
  z.object({ type: z.literal("tool"), name: z.string().max(100), title: z.string().max(500) }),
  /** Prose the harness wrote. The last one is the task's summary. */
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("pr"), url: z.string().url() }),
  z.object({
    type: z.literal("usage"),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
    /** The model the harness says it used. */
    model: z.string().max(200).optional(),
  }),
  /** Always the last event of a task. */
  z.object({
    type: z.literal("done"),
    ok: z.boolean(),
    exitCode: z.number().int().optional(),
    error: z.string().max(4000).optional(),
  }),
]);
export type RunnerEvent = z.infer<typeof RunnerEvent>;
