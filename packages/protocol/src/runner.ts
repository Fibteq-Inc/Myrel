import { z } from "zod";
import { idPattern } from "./ids";
import { ProjectId, ThreadId, Timestamp } from "./models";

/**
 * altair-runner: a small daemon on the user's own computer. It opens an
 * outbound WebSocket to the server and runs tasks with the user's own CLI
 * (Claude Code, Codex, Gemini CLI) in folders the user shared on that
 * computer. The CLI keeps its own login; no subscription token ever reaches
 * the server.
 */

/** Bump on breaking changes to the runner wire protocol. */
export const RUNNER_PROTOCOL_VERSION = 1;

export const RunnerId = z.string().regex(idPattern("runner"));
export const TaskId = z.string().regex(idPattern("task"));

export const CliId = z.enum(["claude", "codex", "gemini"]);
export type CliId = z.infer<typeof CliId>;

export const CLI_NAMES: Record<CliId, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
};

/** A folder the user shared from their computer with `altair-runner share`. */
export const RunnerFolder = z.object({ path: z.string().min(1).max(1024), name: z.string().max(255) });
export type RunnerFolder = z.infer<typeof RunnerFolder>;

/** A CLI the runner found installed on the computer. */
export const RunnerCli = z.object({ id: CliId, version: z.string().max(200).nullable() });
export type RunnerCli = z.infer<typeof RunnerCli>;

/** What the runner last told the server about the computer. */
export const RunnerInfo = z.object({
  version: z.string().max(50),
  hostname: z.string().max(255),
  platform: z.string().max(50),
  folders: z.array(RunnerFolder).max(200),
  clis: z.array(RunnerCli).max(10),
});
export type RunnerInfo = z.infer<typeof RunnerInfo>;

const MAX_TASK_TEXT = 100_000;

/** Frames the runner sends. */
export const RunnerToServer = z.discriminatedUnion("type", [
  RunnerInfo.extend({
    type: z.literal("hello"),
    protocol: z.number().int().positive(),
    /** Tasks still running on the computer, e.g. after a reconnect. */
    running: z.array(TaskId).max(100).default([]),
  }),
  /** A line of progress from the CLI (what it is doing now). */
  z.object({ type: z.literal("task.progress"), taskId: TaskId, text: z.string().max(2000) }),
  z.object({
    type: z.literal("task.done"),
    taskId: TaskId,
    ok: z.boolean(),
    /** The CLI's final answer, or what went wrong. */
    result: z.string().max(MAX_TASK_TEXT),
  }),
  z.object({ type: z.literal("ping") }),
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
  }),
  z.object({ type: z.literal("pong") }),
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

/** Shown in the web app; typed into `altair-runner pair` within a few minutes. */
export const RunnerPairingCode = z.object({ code: z.string(), expiresAt: Timestamp });
export type RunnerPairingCode = z.infer<typeof RunnerPairingCode>;

/** Sent by `altair-runner pair`, without a user session: the code is the proof. */
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

export const SetWorkspaceInput = z.object({
  runnerId: RunnerId,
  path: z.string().min(1).max(1024),
  cli: CliId,
});
export type SetWorkspaceInput = z.infer<typeof SetWorkspaceInput>;
