import { z } from "zod";
import { idPattern } from "./ids";
import { FilePath } from "./paths";

export const MessageId = z.string().regex(idPattern("message"));
export const ThreadId = z.string().regex(idPattern("thread"));
export const ProjectId = z.string().regex(idPattern("project"));

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

export const AddProjectRepoInput = z.object({
  installationId: z.number().int().positive(),
  repoId: z.number().int().positive(),
});
export type AddProjectRepoInput = z.infer<typeof AddProjectRepoInput>;
