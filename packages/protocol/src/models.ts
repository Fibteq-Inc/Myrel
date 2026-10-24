import { z } from "zod";
import { idPattern } from "./ids";
import { FilePath } from "./paths";

export const MessageId = z.string().regex(idPattern("message"));
export const ThreadId = z.string().regex(idPattern("thread"));
export const ProjectId = z.string().regex(idPattern("project"));
export const TaskId = z.string().regex(idPattern("task"));
export const ArtifactId = z.string().regex(idPattern("artifact"));

/** ISO-8601 timestamp string. */
export const Timestamp = z.iso.datetime();

export const AuthorKind = z.enum(["user", "agent", "system"]);
export type AuthorKind = z.infer<typeof AuthorKind>;

/** A file attached to a message. It lives in the project files, so agents read it like any other. */
export const Attachment = z.object({
  path: FilePath,
  name: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
});
export type Attachment = z.infer<typeof Attachment>;

/** An artifact an agent delivered with a message, shown as a card under it. */
export const ArtifactRef = z.object({
  artifactId: ArtifactId,
  /** The version this message delivered; the card can still open the latest. */
  version: z.number().int().positive(),
  title: z.string(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

/** Where a reply's work ran: Myrel's cloud (the Worker or a sandbox) or the person's computer (myrel-runner). */
export const Runtime = z.enum(["cloud", "local"]);
export type Runtime = z.infer<typeof Runtime>;

const Count = z.number().int().nonnegative();

/** The coding task a reply reports on (`run_task`), summed. */
export const TaskStats = z.object({
  title: z.string(),
  /** The harness or the person's CLI, e.g. "opencode", "claude". */
  harness: z.string(),
  runtime: Runtime,
  /** The task's model, when Myrel chose it; a person's own CLI picks its own. */
  model: z.string().nullable(),
  durationMs: Count,
  inputTokens: Count,
  outputTokens: Count,
  /** Millionths of a US dollar; null when unknown. */
  costMicros: Count.nullable(),
});
export type TaskStats = z.infer<typeof TaskStats>;

/** What it took to write an agent's message: the model calls since its previous message, and any task it reports. */
export const MessageStats = z.object({
  /** The model that answered (the one a router picked, when it says). */
  model: z.string(),
  durationMs: Count,
  calls: Count,
  inputTokens: Count,
  cachedInputTokens: Count,
  outputTokens: Count,
  /** Millionths of a US dollar; null when the model has no known price. */
  costMicros: Count.nullable(),
  /** Where the work behind the message ran. */
  runtime: Runtime,
  /**
   * The harness that wrote the message, for a thread's agent ("opencode", or the person's CLI such as
   * "claude"). Its model is empty when the CLI did not say which one it used.
   */
  harness: z.string().optional(),
  task: TaskStats.optional(),
});
export type MessageStats = z.infer<typeof MessageStats>;

/**
 * brief: the coordinator opened a thread with this brief. follow_up: it forwarded a person's
 * follow-up. reply: it answered a thread's request. relay: it passed news from another thread.
 */
export const RelayKind = z.enum(["brief", "follow_up", "reply", "relay", "answer"]);
export type RelayKind = z.infer<typeof RelayKind>;

/** What the coordinator sent a thread's agent, carried by the one-line message that says so. */
export const MessageRelay = z.object({
  kind: RelayKind,
  /** The thread the note went to. */
  threadId: ThreadId,
  /** relay only: the thread the news came from. */
  fromThreadId: ThreadId.optional(),
  note: z.string(),
});
export type MessageRelay = z.infer<typeof MessageRelay>;

/** How many CLIs a person can offer for one ask. */
export const MAX_THREAD_CLIS = 8;

export const Message = z.object({
  id: MessageId,
  projectId: ProjectId,
  /** null = project chat; otherwise the thread the message belongs to. */
  threadId: ThreadId.nullable(),
  authorKind: AuthorKind,
  authorId: z.string().min(1),
  body: z.string(),
  /** Files attached to the message, stored in the project files. Absent = none. */
  attachments: z.array(Attachment).optional(),
  /** Artifacts delivered with the message. Absent = none (and from servers older than artifacts). */
  artifacts: z.array(ArtifactRef).optional(),
  /** Agent messages only: model, time, tokens and where it ran. Absent on older messages. */
  stats: MessageStats.optional(),
  /** Coordinator messages only: the note it sent a thread, which people can open under the line. */
  relay: MessageRelay.optional(),
  /**
   * A person's project-chat ask only: the CLIs on their computer the thread for it may run with
   * (CliId values). One: the thread runs with it. Several: the coordinator picks one. Absent: the
   * project folder's CLI.
   */
  clis: z.array(z.string().max(40)).max(MAX_THREAD_CLIS).optional(),
  /** Per-project monotonically increasing sequence number, used for sync. */
  seq: z.number().int().positive(),
  createdAt: Timestamp,
  /** When its author last changed the text (`message.edit`). Absent: never edited. */
  editedAt: Timestamp.optional(),
});
export type Message = z.infer<typeof Message>;

/**
 * working: the thread agent is running a turn. blocked: it waits on the coordinator.
 * review_ready: its turn ended and it waits on a person. done: resolved. failed: the turn errored.
 */
export const ThreadStatus = z.enum(["working", "blocked", "review_ready", "done", "failed"]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

/**
 * Why a resolved thread was closed without its work being done: it repeated another thread's ask,
 * it was opened for something another thread covers, or the ask was dropped. Null when it was
 * resolved the usual way, and again once it is reopened.
 */
/**
 * The CLI a thread runs with on the person's computer, instead of the project folder's. `id` is a
 * CliId, kept a plain string here so a CLI Myrel drops later does not break the thread (the server
 * then asks for another one). by: "person" (they picked it, from the composer or the thread) or
 * "coordinator" (it picked among `options`, the CLIs the person offered, for `reason`).
 */
export const ThreadCli = z.object({
  id: z.string().max(40),
  options: z.array(z.string().max(40)).max(MAX_THREAD_CLIS),
  by: z.enum(["person", "coordinator"]),
  reason: z.string().max(300).nullable(),
});
export type ThreadCli = z.infer<typeof ThreadCli>;

/**
 * The model and effort a person picked for a thread, for the CLI `cli`. When the thread runs with
 * another CLI, it does not apply (models belong to one CLI) and the project's default for that CLI does.
 * null model or effort: the project's default for that part.
 */
export const ThreadModel = z.object({
  cli: z.string().max(40),
  model: z.string().max(200).nullable(),
  effort: z.string().max(20).nullable(),
});
export type ThreadModel = z.infer<typeof ThreadModel>;

/**
 * The computer a thread works on, among the project's local folders. by: "person" (its owner picked
 * it; the thread waits for it) or "auto" (the thread's first local turn ran there, so its CLI session
 * and uncommitted work are there: it stays unless the computer leaves the project).
 */
export const ThreadRunner = z.object({
  id: z.string().max(60),
  by: z.enum(["person", "auto"]),
});
export type ThreadRunner = z.infer<typeof ThreadRunner>;

export const ThreadCloseReason = z.enum(["duplicate", "misrouted", "cancelled"]);
export type ThreadCloseReason = z.infer<typeof ThreadCloseReason>;

export const Thread = z.object({
  id: ThreadId,
  projectId: ProjectId,
  /** The project-chat message the thread hangs under. */
  rootMessageId: MessageId,
  /**
   * The coordinator's one-line acknowledgement in the project chat ("On it"), posted right under the
   * person's message. Clients show the thread card under this line when it is set.
   */
  ackMessageId: MessageId.nullable().default(null),
  title: z.string(),
  status: ThreadStatus,
  /** The thread agent's progress checklist (`update_status`), shown while it works. */
  statusText: z.string().nullable(),
  resolved: z.boolean(),
  closeReason: ThreadCloseReason.nullable().default(null),
  /** For a duplicate: the thread that carries the work. */
  duplicateOf: ThreadId.nullable().default(null),
  label: z.string().nullable(),
  /** The CLI it runs with on the person's computer; null: the project folder's (and from older servers). */
  cli: ThreadCli.nullable().default(null),
  /** The computer it works on; null: the project's default one (and from older servers). */
  runner: ThreadRunner.nullable().default(null),
  /** The model and effort picked for this thread; null: the project's defaults (and from older servers). */
  model: ThreadModel.nullable().default(null),
  /**
   * The last message the thread's agent has taken in. A person's message after it, while the thread
   * is working, waits for the agent: clients show it as queued. Null: not known (older servers).
   */
  seenSeq: z.number().int().nonnegative().nullable().default(null),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Thread = z.infer<typeof Thread>;

/** running: the runner is working. The other states are final. */
export const TaskStatus = z.enum(["running", "done", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** A piece of work a thread agent handed to a runner (`run_task`): code edits, commands, a pull request. */
export const Task = z.object({
  id: TaskId,
  threadId: ThreadId,
  title: z.string(),
  /** The coding harness, e.g. "opencode". */
  harness: z.string(),
  /** Where it runs: "sandbox" (cloud) or "local" (the person's machine). */
  backend: z.string(),
  status: TaskStatus,
  prUrl: z.string().nullable(),
  /** The harness's closing words, or why the task failed. */
  summary: z.string().nullable(),
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type Task = z.infer<typeof Task>;

/** What a thread's cloud tasks saved (its workspace): recent history and one folder or file. */
export const ThreadFiles = z.object({
  ref: z.string(),
  commits: z.array(z.object({ hash: z.string(), message: z.string(), at: z.string() })),
  entries: z.array(z.object({ name: z.string(), path: z.string(), type: z.enum(["file", "folder"]) })).nullable(),
  file: z.object({ path: z.string(), text: z.string().nullable(), size: z.number(), truncated: z.boolean() }).nullable(),
});
export type ThreadFiles = z.infer<typeof ThreadFiles>;

export const TerminalLine = z.object({
  stream: z.enum(["stdout", "stderr", "system"]),
  text: z.string(),
  /** When the line arrived (epoch ms). Absent on lines from before it was recorded. */
  at: z.number().optional(),
  /** How long the step on this line took (a tool call, opening the sandbox), when known. */
  ms: z.number().nonnegative().optional(),
  /** The line is a tool call (a command, a file edit). */
  tool: z.boolean().optional(),
});
export type TerminalLine = z.infer<typeof TerminalLine>;

export const Reaction = z.object({
  messageId: MessageId,
  emoji: z.string().min(1).max(32),
  authorKind: AuthorKind,
  authorId: z.string().min(1),
});
export type Reaction = z.infer<typeof Reaction>;

/** owner: everything, incl. ownership. admin: manages members, invites and settings. member: works in the project. */
export const ProjectRole = z.enum(["owner", "admin", "member"]);
export type ProjectRole = z.infer<typeof ProjectRole>;

/** What is going on in a project right now, for the project list. */
export const ProjectActivity = z.object({
  /** Agents working now: the coordinator and threads mid-turn. */
  working: z.number().int().nonnegative(),
  /** Open threads waiting on a person: a decision, an approval or a blocker. */
  waiting: z.number().int().nonnegative(),
});
export type ProjectActivity = z.infer<typeof ProjectActivity>;

/** What a project's model calls have cost, for the project list. Priced calls only. */
export const ProjectCost = z.object({
  /** Since the start of this calendar month (UTC), the period plan limits count. */
  monthMicros: z.number().int().nonnegative(),
  totalMicros: z.number().int().nonnegative(),
});
export type ProjectCost = z.infer<typeof ProjectCost>;

export const Project = z.object({
  id: ProjectId,
  name: z.string().min(1).max(120),
  role: ProjectRole,
  createdAt: Timestamp,
  /** Missing from servers older than this field. */
  activity: ProjectActivity.optional(),
  /** Missing from servers older than this field. */
  cost: ProjectCost.optional(),
});
export type Project = z.infer<typeof Project>;

export const CreateProjectInput = z.object({
  name: z.string().trim().min(1).max(120),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const Member = z.object({
  id: z.string(),
  name: z.string(),
  role: ProjectRole,
  /** Shown to project owners and admins only. */
  email: z.string().optional(),
});
export type Member = z.infer<typeof Member>;

export const MAX_MESSAGE_LENGTH = 32_000;

// --- GitHub ---

/** A GitHub App installation (a user or organization account) the current user can use. */
export const GithubInstallation = z.object({
  id: z.number().int(),
  accountLogin: z.string(),
  accountType: z.enum(["User", "Organization"]),
  accountAvatarUrl: z.string().nullable(),
});
export type GithubInstallation = z.infer<typeof GithubInstallation>;

/** `GET /api/github`: whether this server has a GitHub App, and the user's installations. */
export const GithubStatus = z.object({
  configured: z.boolean(),
  /** Page on GitHub where the app is installed on more accounts or given more repositories. */
  installUrl: z.string().nullable(),
  installations: z.array(GithubInstallation),
});
export type GithubStatus = z.infer<typeof GithubStatus>;

/** A repository the GitHub App can reach. */
export const GithubRepo = z.object({
  id: z.number().int(),
  installationId: z.number().int(),
  fullName: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
  description: z.string().nullable(),
});
export type GithubRepo = z.infer<typeof GithubRepo>;

/** A repository connected to a project. Thread agents work in these. */
export const ProjectRepo = z.object({
  repoId: z.number().int(),
  installationId: z.number().int(),
  fullName: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
  createdAt: Timestamp,
});
export type ProjectRepo = z.infer<typeof ProjectRepo>;

/** A pull request a thread's task opened, with its live state from GitHub. */
export const PullRequest = z.object({
  /** owner/name. */
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  threadId: ThreadId,
  title: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  /** Combined CI result on the head commit; null when the repository runs no checks. */
  checks: z.enum(["pending", "success", "failure"]).nullable(),
  /** The latest decisive review; null when nobody approved or asked for changes. */
  review: z.enum(["approved", "changes_requested"]).nullable(),
  /** The branch conflicts with its base and cannot be merged until that is resolved. */
  conflict: z.boolean().default(false),
  updatedAt: Timestamp,
});
export type PullRequest = z.infer<typeof PullRequest>;

export const AddProjectRepoInput = z.object({
  installationId: z.number().int().positive(),
  repoId: z.number().int().positive(),
});
export type AddProjectRepoInput = z.infer<typeof AddProjectRepoInput>;
