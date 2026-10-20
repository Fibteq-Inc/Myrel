import { z } from "zod";
import { idPattern } from "./ids";
import { ProjectId, TaskId, ThreadId, Timestamp } from "./models";

/**
 * myrel-runner: a small daemon on the user's own computer. It opens an
 * outbound WebSocket to the server and runs tasks with the user's own CLI
 * (Claude Code, Codex, Gemini CLI) in folders the user shared on that
 * computer. The CLI keeps its own login; no subscription token ever reaches
 * the server.
 */

/** Bump on breaking changes to the runner wire protocol. */
export const RUNNER_PROTOCOL_VERSION = 2;

export const RunnerId = z.string().regex(idPattern("runner"));

export const CliId = z.enum(["claude", "codex", "gemini"]);
export type CliId = z.infer<typeof CliId>;

export const CLI_NAMES: Record<CliId, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
};

/** A folder the user shared from their computer with `myrel-runner share`. */
export const RunnerFolder = z.object({ path: z.string().min(1).max(1024), name: z.string().max(255) });
export type RunnerFolder = z.infer<typeof RunnerFolder>;

/** A CLI the runner found installed on the computer. */
export const RunnerCli = z.object({ id: CliId, version: z.string().max(200).nullable() });
export type RunnerCli = z.infer<typeof RunnerCli>;

/**
 * Optional abilities a runner announces in hello, so the server only asks
 * what that version can do. "folders": browse and share folders from the web app.
 * "agent": run Claude Code as the thread's agent, with Myrel's tools over MCP (task.start's `agent`).
 * "agent-clis": the same for Codex CLI and Gemini CLI.
 */
export const RunnerFeature = z.enum(["folders", "cancel", "agent", "agent-clis"]);
export type RunnerFeature = z.infer<typeof RunnerFeature>;

/** What the runner last told the server about the computer. */
export const RunnerInfo = z.object({
  version: z.string().max(50),
  hostname: z.string().max(255),
  platform: z.string().max(50),
  folders: z.array(RunnerFolder).max(200),
  clis: z.array(RunnerCli).max(10),
  /** Unknown features from newer runners are dropped, not refused. */
  features: z
    .array(z.string().max(50))
    .max(20)
    .default([])
    .transform((all) => all.filter((f): f is RunnerFeature => RunnerFeature.safeParse(f).success)),
});
export type RunnerInfo = z.infer<typeof RunnerInfo>;

const MAX_TASK_TEXT = 100_000;

/** Ties a runner's answer to the server's request. */
export const RunnerRequestId = z.string().min(1).max(64);

/** A folder inside the one being browsed. */
export const RunnerDir = z.object({ name: z.string().max(255), path: z.string().max(1024) });
export type RunnerDir = z.infer<typeof RunnerDir>;

/** One level of the computer's folders, as shown in the folder picker. */
export const RunnerDirListing = z.object({
  path: z.string().max(1024),
  /** null at the top (the filesystem root). */
  parent: z.string().max(1024).nullable(),
  /** The user's home folder, where browsing starts. */
  home: z.string().max(1024),
  dirs: z.array(RunnerDir).max(1000),
});
export type RunnerDirListing = z.infer<typeof RunnerDirListing>;

/** What the CLI reported using so far in one task, summed from its start. Older runners never send it. */
export const CliUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** The model the CLI says it used, when it says. */
  model: z.string().max(200).optional(),
});
export type CliUsage = z.infer<typeof CliUsage>;

/** Frames the runner sends. */
export const RunnerToServer = z.discriminatedUnion("type", [
  RunnerInfo.extend({
    type: z.literal("hello"),
    protocol: z.number().int().positive(),
    /** Tasks still running on the computer, e.g. after a reconnect. */
    running: z.array(TaskId).max(100).default([]),
  }),
  /** A line of progress from the CLI (what it is doing now). Empty when only its usage changed. */
  z.object({ type: z.literal("task.progress"), taskId: TaskId, text: z.string().max(2000), usage: CliUsage.optional() }),
  z.object({
    type: z.literal("task.done"),
    taskId: TaskId,
    ok: z.boolean(),
    usage: CliUsage.optional(),
    /** The CLI's final answer, or what went wrong. */
    result: z.string().max(MAX_TASK_TEXT),
    /** Stopped because the server asked ("task.cancel"). */
    cancelled: z.boolean().optional(),
  }),
  z.object({ type: z.literal("ping") }),
  // Answers to the server's folder requests (feature "folders").
  RunnerDirListing.extend({ type: z.literal("dirs"), requestId: RunnerRequestId }),
  z.object({ type: z.literal("folders"), requestId: RunnerRequestId, folders: z.array(RunnerFolder).max(200) }),
  z.object({ type: z.literal("request.failed"), requestId: RunnerRequestId, message: z.string().max(500) }),
]);
export type RunnerToServer = z.infer<typeof RunnerToServer>;

/** Frames the server sends. */
export const ServerToRunner = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), runnerId: RunnerId, name: z.string() }),
  z.object({
    type: z.literal("task.start"),
    taskId: TaskId,
    /** Tasks of one thread continue the same CLI session where the CLI supports it. */
    threadId: ThreadId,
    /** Must be one of the runner's shared folders; the runner refuses anything else. */
    folder: z.string().min(1).max(1024),
    cli: CliId,
    prompt: z.string().min(1).max(MAX_TASK_TEXT),
    /**
     * Present when the CLI runs as the thread's agent instead of doing one task for it: the
     * runner connects the CLI to the thread's MCP endpoint (server origin + mcpPath) with this
     * token, so it talks to people through Myrel's tools. Needs feature "agent".
     */
    agent: z
      .object({ mcpPath: z.string().regex(/^\/api\/[\w/-]+$/).max(300), token: z.string().min(20).max(200) })
      .optional(),
  }),
  /** Stop a running task. The runner answers with its "task.done" (cancelled: true). Needs feature "cancel". */
  z.object({ type: z.literal("task.cancel"), taskId: TaskId }),
  z.object({ type: z.literal("pong") }),
  /** List the folders inside `path` (the home folder when absent). Answered with "dirs". */
  z.object({ type: z.literal("dirs.list"), requestId: RunnerRequestId, path: z.string().max(1024).optional() }),
  /** Share or stop sharing a folder, as asked in the web app. Answered with "folders". */
  z.object({ type: z.literal("folder.share"), requestId: RunnerRequestId, path: z.string().min(1).max(1024) }),
  z.object({ type: z.literal("folder.unshare"), requestId: RunnerRequestId, path: z.string().min(1).max(1024) }),
]);
export type ServerToRunner = z.infer<typeof ServerToRunner>;

// ---- REST ------------------------------------------------------------------

/** A computer paired with the user's account. */
export const Runner = RunnerInfo.extend({
  id: RunnerId,
  name: z.string(),
  /** null until the runner has connected once. */
  version: z.string().nullable(),
  online: z.boolean(),
  lastSeenAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type Runner = z.infer<typeof Runner>;

/** Shown in the web app; typed into `myrel-runner pair` within a few minutes. */
export const RunnerPairingCode = z.object({ code: z.string(), expiresAt: Timestamp });
export type RunnerPairingCode = z.infer<typeof RunnerPairingCode>;

/** Sent by `myrel-runner pair`, without a user session: the code is the proof. */
export const PairRunnerInput = z.object({
  code: z.string().trim().min(4).max(20),
  name: z.string().trim().min(1).max(80),
  hostname: z.string().max(255).default(""),
  platform: z.string().max(50).default(""),
});
export type PairRunnerInput = z.infer<typeof PairRunnerInput>;

export const PairRunnerResult = z.object({
  runner: z.object({ id: RunnerId, name: z.string() }),
  /** Long-lived secret the runner keeps on the computer. Shown once. */
  token: z.string(),
});
export type PairRunnerResult = z.infer<typeof PairRunnerResult>;

/** The local folder a project works in. */
export const ProjectWorkspace = z.object({
  projectId: ProjectId,
  runnerId: RunnerId,
  runnerName: z.string(),
  path: z.string(),
  cli: CliId,
  online: z.boolean(),
});
export type ProjectWorkspace = z.infer<typeof ProjectWorkspace>;

/** Share or stop sharing a folder on one of your computers. */
export const RunnerFolderInput = z.object({ path: z.string().trim().min(1).max(1024) });
export type RunnerFolderInput = z.infer<typeof RunnerFolderInput>;

export const SetWorkspaceInput = z.object({
  runnerId: RunnerId,
  path: z.string().min(1).max(1024),
  cli: CliId,
});
export type SetWorkspaceInput = z.infer<typeof SetWorkspaceInput>;
