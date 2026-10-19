import { z } from "zod";
import { idPattern } from "./ids";

export const MessageId = z.string().regex(idPattern("message"));
export const ThreadId = z.string().regex(idPattern("thread"));
export const ProjectId = z.string().regex(idPattern("project"));
export const TaskId = z.string().regex(idPattern("task"));

/** ISO-8601 timestamp string. */
export const Timestamp = z.iso.datetime();

export const AuthorKind = z.enum(["user", "agent", "system"]);
export type AuthorKind = z.infer<typeof AuthorKind>;

export const Message = z.object({
  id: MessageId,
  projectId: ProjectId,
  /** null = project chat; otherwise the thread the message belongs to. */
  threadId: ThreadId.nullable(),
  authorKind: AuthorKind,
  authorId: z.string().min(1),
  body: z.string(),
  /** Per-project monotonically increasing sequence number, used for sync. */
  seq: z.number().int().positive(),
  createdAt: Timestamp,
});
export type Message = z.infer<typeof Message>;

/**
 * working: the thread agent is running a turn. blocked: it waits on the coordinator.
 * review_ready: its turn ended and it waits on a person. done: resolved. failed: the turn errored.
 */
export const ThreadStatus = z.enum(["working", "blocked", "review_ready", "done", "failed"]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

export const Thread = z.object({
  id: ThreadId,
  projectId: ProjectId,
  /** The project-chat message the thread hangs under. */
  rootMessageId: MessageId,
  title: z.string(),
  status: ThreadStatus,
  /** The thread agent's progress checklist (`update_status`), shown while it works. */
  statusText: z.string().nullable(),
  resolved: z.boolean(),
  label: z.string().nullable(),
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

export const TerminalLine = z.object({ stream: z.enum(["stdout", "stderr", "system"]), text: z.string() });
export type TerminalLine = z.infer<typeof TerminalLine>;

export const Reaction = z.object({
  messageId: MessageId,
  emoji: z.string().min(1).max(32),
  authorKind: AuthorKind,
  authorId: z.string().min(1),
});
export type Reaction = z.infer<typeof Reaction>;

export const ProjectRole = z.enum(["owner", "member"]);
export type ProjectRole = z.infer<typeof ProjectRole>;

export const Project = z.object({
  id: ProjectId,
  name: z.string().min(1).max(120),
  role: ProjectRole,
  createdAt: Timestamp,
});
export type Project = z.infer<typeof Project>;

export const CreateProjectInput = z.object({
  name: z.string().trim().min(1).max(120),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const Member = z.object({ id: z.string(), name: z.string(), role: ProjectRole });
export type Member = z.infer<typeof Member>;

export const MAX_MESSAGE_LENGTH = 32_000;
