import { z } from "zod";
import { idPattern } from "./ids";
import { ProjectId, TaskId, ThreadId, Timestamp } from "./models";

/**
 * myrel-runner: a small daemon on the user's own computer. It opens an
 * outbound WebSocket to the server and runs tasks with the user's own CLI
 * (Claude Code, Codex, Antigravity CLI, OpenCode, Hermes, Cursor CLI, Muse Code, Kimi Code) in folders the user shared on that
 * computer. The CLI keeps its own login; no subscription token ever reaches
 * the server.
 */

/** Bump on breaking changes to the runner wire protocol. */
export const RUNNER_PROTOCOL_VERSION = 2;

export const RunnerId = z.string().regex(idPattern("runner"));

export const CliId = z.enum(["claude", "codex", "antigravity", "opencode", "hermes", "cursor", "muse", "kimi"]);
export type CliId = z.infer<typeof CliId>;

export const CLI_NAMES: Record<CliId, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  antigravity: "Antigravity CLI",
  opencode: "OpenCode",
  hermes: "Hermes Agent",
  cursor: "Cursor CLI",
  muse: "Muse Code",
  kimi: "Kimi Code",
};

/** A folder the user shared from their computer with `myrel-runner share`. */
export const RunnerFolder = z.object({ path: z.string().min(1).max(1024), name: z.string().max(255) });
export type RunnerFolder = z.infer<typeof RunnerFolder>;

/**
 * One usage window of a CLI's subscription. kind: "session" (5 hours), "weekly", "weekly_opus",
 * "weekly_sonnet", or another name a newer runner knows; the web app skips kinds it does not know.
 */
export const CliLimitWindow = z.object({
  kind: z.string().max(40),
  /** Share of the window used, 0-100; can pass 100 when the CLI lets usage run over. */
  usedPercent: z.number().min(0).max(1000).nullable(),
  resetsAt: Timestamp.nullable(),
});
export type CliLimitWindow = z.infer<typeof CliLimitWindow>;

/**
 * A CLI's subscription limits, as the CLI itself last reported them: Claude Code in its
 * rate_limit_event, Codex in its session files. Never asked from the providers' APIs.
 */
export const CliLimits = z.object({
  /** "limited" when the CLI refuses work until a window resets. */
  status: z.enum(["ok", "warning", "limited"]).optional(),
  windows: z.array(CliLimitWindow).max(8),
  /** When the CLI reported them. */
  at: Timestamp,
});
export type CliLimits = z.infer<typeof CliLimits>;

/** Effort (thinking) levels a CLI may take, lowest first; a CLI's own list may hold others too. */
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/**
 * A model a CLI offers, as the CLI itself lists it. `efforts`: the effort levels this model takes;
 * empty when the CLI takes no effort for it, so none is offered.
 */
export const CliModel = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(200),
  efforts: z.array(z.string().min(1).max(20)).max(10),
});
export type CliModel = z.infer<typeof CliModel>;

/**
 * The efforts to offer for `model` of a CLI's list. With no model picked the CLI's default runs, which
 * may be any of them: then only the efforts every model that takes one takes. Empty: offer none.
 */
export function effortsFor(models: CliModel[], model: string | null): string[] {
  if (model) return models.find((m) => m.id === model)?.efforts ?? [];
  const taking = models.filter((m) => m.efforts.length > 0);
  return taking.reduce<string[]>((all, m, i) => (i === 0 ? [...m.efforts] : all.filter((e) => m.efforts.includes(e))), []);
}

/** A CLI the runner found installed on the computer. */
export const RunnerCli = z.object({
  id: CliId,
  version: z.string().max(200).nullable(),
  /** Older runners never send it; a malformed one is dropped, not the whole hello. */
  limits: CliLimits.optional().catch(undefined),
  /**
   * The models the CLI lists, read in the background after the runner starts (feature "models").
   * Absent when the CLI lists none or could not be asked: then nothing is offered and it runs with its own default.
   */
  models: z.array(CliModel).max(100).optional().catch(undefined),
});
export type RunnerCli = z.infer<typeof RunnerCli>;

/**
 * Optional abilities a runner announces in hello, so the server only asks
 * what that version can do. "folders": browse and share folders from the web app.
 * "agent": run Claude Code as the thread's agent, with Myrel's tools over MCP (task.start's `agent`).
 * "agent-clis": the same for Codex CLI, Antigravity CLI, OpenCode, Hermes Agent, Cursor CLI, Muse Code and Kimi Code.
 * "connectors": the agent also gets the thread's connectors (task.start's `agent.connectors`).
 * "skills": the runner downloads the turn's skills (task.start's `agent.skills`) into a folder of the run.
 * "files": reads a file in the project's folders for the web app to show ("file.read").
 * "project-folders": the CLI also gets the project's other folders (task.start's `folders`), reports
 * the folders it works in ("task.folders"), and Claude Code asks people through Myrel before touching
 * anything outside them (the thread's approve_access tool).
 * "settings": reports its settings in hello and changes them when asked ("settings.set").
 * "update": updates itself to a newer version when asked ("runner.update"), if it can (`updates`).
 * "models": lists each CLI's models (RunnerCli.models) and runs the one in task.start's `model`.
 */
export const RunnerFeature = z.enum([
  "folders",
  "cancel",
  "agent",
  "agent-clis",
  "connectors",
  "skills",
  "project-folders",
  "files",
  "settings",
  "update",
  "models",
]);

/**
 * A connector (MCP server) for the CLI running as the thread's agent. A remote one is on this
 * runner's server (origin + path, with the run's token); a command starts on this computer with
 * these environment variables.
 */
export const AgentConnector = z.discriminatedUnion("transport", [
  z.object({ transport: z.literal("http"), name: z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/), path: z.string().regex(/^\/api\/[\w/-]+$/).max(300) }),
  z.object({
    transport: z.literal("stdio"),
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/),
    command: z.string().min(1).max(200),
    args: z.array(z.string().max(2000)).max(50),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4000)),
  }),
]);
export type AgentConnector = z.infer<typeof AgentConnector>;
export type RunnerFeature = z.infer<typeof RunnerFeature>;

/**
 * What the CLI may do without asking. read: look only. edit: change files in the folders. auto: Claude
 * Code's auto mode (it runs the steps it judges safe and asks about the rest; edit for other CLIs).
 * full: also run any command.
 */
export const RunnerAccess = z.enum(["read", "edit", "auto", "full"]);
export type RunnerAccess = z.infer<typeof RunnerAccess>;

/** The runner's settings, as saved in its config.json on the computer (feature "settings"). */
export const RunnerSettings = z.object({
  access: RunnerAccess,
  /** Each thread works in its own git worktree and branch. */
  worktrees: z.boolean(),
  /** Installs a newer version by itself when no task is running. */
  autoUpdate: z.boolean(),
  /**
   * false when the person turned off changing these from Myrel on the computer itself
   * (`myrel-runner settings remote off`). Only the computer can turn it back on.
   */
  remote: z.boolean(),
});
export type RunnerSettings = z.infer<typeof RunnerSettings>;

/** What the web app may change; `remote` is only changed on the computer. */
export const RunnerSettingsInput = RunnerSettings.omit({ remote: true }).partial();
export type RunnerSettingsInput = z.infer<typeof RunnerSettingsInput>;

/**
 * How the runner can be updated. service: the background runner updates itself ("runner.update").
 * app: it came with the desktop app, which updates it. manual: it runs in a terminal, so the person
 * starts the new version there.
 */
export const RunnerUpdates = z.enum(["service", "app", "manual"]);
export type RunnerUpdates = z.infer<typeof RunnerUpdates>;

/** Where an update the runner was asked for (or started itself) is. */
export const RunnerUpdateState = z.object({
  state: z.enum(["waiting", "downloading", "restarting", "failed", "rolled-back"]),
  /** The version being installed. */
  version: z.string().max(50),
  /** Tasks it waits for (state "waiting"). */
  running: z.number().int().nonnegative().optional(),
  /** What went wrong (states "failed" and "rolled-back"). */
  message: z.string().max(500).optional(),
  at: Timestamp,
});
export type RunnerUpdateState = z.infer<typeof RunnerUpdateState>;

/** What the runner last told the server about the computer. */
export const RunnerInfo = z.object({
  version: z.string().max(50),
  hostname: z.string().max(255),
  platform: z.string().max(50),
  folders: z.array(RunnerFolder).max(200),
  /** CLIs Myrel no longer supports (Gemini CLI, from older runners) are dropped, not refused. */
  clis: z
    .array(z.unknown())
    .max(10)
    .transform((all) =>
      all.flatMap((c) => {
        const cli = RunnerCli.safeParse(c);
        return cli.success ? [cli.data] : [];
      }),
    ),
  /** Unknown features from newer runners are dropped, not refused. */
  features: z
    .array(z.string().max(50))
    .max(20)
    .default([])
    .transform((all) => all.filter((f): f is RunnerFeature => RunnerFeature.safeParse(f).success)),
  // Older runners never send these; a malformed one is dropped, not the whole hello.
  settings: RunnerSettings.optional().catch(undefined),
  updates: RunnerUpdates.optional().catch(undefined),
  /** An update in progress, or one that did not work out lately. */
  update: RunnerUpdateState.optional().catch(undefined),
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

/** Largest file "file.read" sends back, in bytes; a longer text file comes cut. */
export const MAX_LOCAL_FILE_BYTES = 512 * 1024;

/** A file in a project's folders, read for someone to look at (feature "files"). */
export const RunnerFile = z.object({
  /** Where the file really is on the computer. */
  path: z.string().max(4096),
  size: z.number().int().nonnegative(),
  /** Base64 of the file, or of its first MAX_LOCAL_FILE_BYTES when `truncated`. */
  data: z.string().max(Math.ceil(MAX_LOCAL_FILE_BYTES / 3) * 4 + 4),
  truncated: z.boolean(),
});
export type RunnerFile = z.infer<typeof RunnerFile>;

/**
 * The model and effort a run uses (feature "models"). Either may be absent: then the CLI's own
 * default. The server only sends a model the CLI listed and an effort that model takes.
 */
export const TaskModel = z.object({
  model: z.string().min(1).max(200).optional(),
  effort: z.string().min(1).max(20).optional(),
});
export type TaskModel = z.infer<typeof TaskModel>;

/** Frames the runner sends. */
export const RunnerToServer = z.discriminatedUnion("type", [
  RunnerInfo.extend({
    type: z.literal("hello"),
    protocol: z.number().int().positive(),
    /** Tasks still running on the computer, e.g. after a reconnect. */
    running: z.array(TaskId).max(100).default([]),
    /**
     * Tasks the runner's previous process stopped when it shut down (an update, a restart), so the
     * server can continue them instead of failing them. Older runners never send it.
     */
    interrupted: z.array(TaskId).max(100).default([]),
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
  /** The folders a task's CLI can work in without asking: where it runs first (feature "project-folders"). */
  z.object({ type: z.literal("task.folders"), taskId: TaskId, folders: z.array(z.string().min(1).max(1024)).max(60) }),
  // Answers to the server's folder requests (feature "folders").
  RunnerDirListing.extend({ type: z.literal("dirs"), requestId: RunnerRequestId }),
  z.object({ type: z.literal("folders"), requestId: RunnerRequestId, folders: z.array(RunnerFolder).max(200) }),
  z.object({ type: z.literal("request.failed"), requestId: RunnerRequestId, message: z.string().max(500) }),
  RunnerFile.extend({ type: z.literal("file"), requestId: RunnerRequestId }),
  /** Answers "settings.set" with the settings now saved (feature "settings"). */
  z.object({ type: z.literal("settings"), requestId: RunnerRequestId, settings: RunnerSettings }),
  /** Answers "runner.update": the update has started (feature "update"). */
  z.object({ type: z.literal("update.accepted"), requestId: RunnerRequestId, update: RunnerUpdateState }),
  /** How an update goes on; null once there is nothing to show any more. */
  z.object({ type: z.literal("update.status"), update: RunnerUpdateState.nullable() }),
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
    /** The model and effort to run with (feature "models"); absent: the CLI's own default. */
    model: TaskModel.optional(),
    /** The project's other folders the CLI may also work in; each must be shared too (feature "project-folders"). */
    folders: z.array(z.string().min(1).max(1024)).max(50).optional(),
    /**
     * Present when the CLI runs as the thread's agent instead of doing one task for it: the
     * runner connects the CLI to the thread's MCP endpoint (server origin + mcpPath) with this
     * token, so it talks to people through Myrel's tools. Needs feature "agent".
     */
    agent: z
      .object({
        mcpPath: z.string().regex(/^\/api\/[\w/-]+$/).max(300),
        token: z.string().min(20).max(200),
        /** Connectors besides Myrel's tools (feature "connectors"); older runners ignore them. */
        connectors: z.array(AgentConnector).max(30).optional(),
        /**
         * The turn's skills (feature "skills"): a SkillBundle on this runner's server (origin + path,
         * with the run's token), for the CLI to find in a folder of the run.
         */
        skills: z.object({ path: z.string().regex(/^\/api\/[\w/-]+$/).max(300) }).optional(),
        /**
         * A shorter prompt for a CLI session that continues the thread's last turn, `after` (that
         * turn's task id): the same instructions, but only what is new in the thread since then, as
         * the session already holds the rest. Older runners ignore it and send `prompt`.
         */
        resume: z.object({ after: TaskId, prompt: z.string().min(1).max(MAX_TASK_TEXT) }).optional(),
      })
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
  /**
   * Read one file, e.g. one an agent's message links to (feature "files"). Answered with "file".
   * `path` is absolute or relative to `folders`, the project's folders; the runner reads it only
   * inside those (each shared) or the thread's worktree of them.
   */
  z.object({
    type: z.literal("file.read"),
    requestId: RunnerRequestId,
    path: z.string().min(1).max(4096),
    folders: z.array(z.string().min(1).max(1024)).min(1).max(51),
    threadId: ThreadId.optional(),
  }),
  /** Change some of the runner's settings (feature "settings"). Answered with "settings". */
  z.object({ type: z.literal("settings.set"), requestId: RunnerRequestId, settings: RunnerSettingsInput }),
  /**
   * Update to `version` (feature "update", `updates` "service"): after the running tasks finish, or
   * right away when `now` (Myrel continues the tasks it stops). Answered with "update.accepted".
   */
  z.object({
    type: z.literal("runner.update"),
    requestId: RunnerRequestId,
    version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/).max(50),
    now: z.boolean().default(false),
  }),
]);
export type ServerToRunner = z.infer<typeof ServerToRunner>;
/** What a task.start gives a CLI that runs as the thread's agent. */
export type AgentStart = NonNullable<Extract<ServerToRunner, { type: "task.start" }>["agent"]>;

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

/** Rename a computer, or change its runner's settings (sent to the computer). */
export const UpdateRunnerInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  settings: RunnerSettingsInput.optional(),
});
export type UpdateRunnerInput = z.infer<typeof UpdateRunnerInput>;

/** Ask a computer to update myrel-runner to the newest version. */
export const UpdateRunnerRequest = z.object({ now: z.boolean().default(false) });
export type UpdateRunnerRequest = z.infer<typeof UpdateRunnerRequest>;

/** GET /api/runners. */
export const RunnerList = z.object({
  runners: z.array(Runner),
  /** The newest myrel-runner on npm; null when it could not be looked up. */
  latestVersion: z.string().nullable(),
});
export type RunnerList = z.infer<typeof RunnerList>;

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
  /** Other folders on the same computer the agent may work in too. Anything else needs the person's OK. */
  folders: z.array(z.string()).default([]),
  cli: CliId,
  online: z.boolean(),
  /** The project's default computer: local work goes here unless a thread was set to another. */
  isDefault: z.boolean().default(true),
});
export type ProjectWorkspace = z.infer<typeof ProjectWorkspace>;

/** Share or stop sharing a folder on one of your computers. */
export const RunnerFolderInput = z.object({ path: z.string().trim().min(1).max(1024) });
export type RunnerFolderInput = z.infer<typeof RunnerFolderInput>;

export const SetWorkspaceInput = z.object({
  runnerId: RunnerId,
  path: z.string().min(1).max(1024),
  cli: CliId,
  /**
   * Adds this computer's folder to the project next to its others (or changes it), instead of making
   * it the project's only local folder. The first one becomes the default.
   */
  add: z.boolean().optional(),
});
export type SetWorkspaceInput = z.infer<typeof SetWorkspaceInput>;

/** Adds one of the computer's shared folders to the project's other folders. */
export const WorkspaceFolderInput = z.object({
  path: z.string().min(1).max(1024),
  /** The computer whose local folder it goes with; the project's default one when left out. */
  runnerId: RunnerId.optional(),
});
export type WorkspaceFolderInput = z.infer<typeof WorkspaceFolderInput>;

/** Makes one of the project's computers its default. */
export const WorkspaceDefaultInput = z.object({ runnerId: RunnerId });
export type WorkspaceDefaultInput = z.infer<typeof WorkspaceDefaultInput>;

/** How many other folders a project can have besides its main one. */
export const MAX_WORKSPACE_FOLDERS = 20;

/** Whether myrel-runner version `a` is newer than `b` (major.minor.patch; pre-release tags are ignored). */
export function isNewerRunner(a: string, b: string): boolean {
  const parse = (v: string) => v.split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}
