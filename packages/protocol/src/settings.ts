import { z } from "zod";
import { ProjectColor, ProjectIcon, ProjectRole } from "./models";
import { CliId } from "./runner";

/** Model providers a server can call. Each has its own key format and default model. */
export const ProviderId = z.enum(["fireworks", "anthropic", "openai"]);
export type ProviderId = z.infer<typeof ProviderId>;

export const ProviderInfo = z.object({
  id: ProviderId,
  name: z.string(),
  defaultModel: z.string(),
  /** Whether the server has its own key for it (a secret or an instance key). */
  serverKey: z.boolean(),
});
export type ProviderInfo = z.infer<typeof ProviderInfo>;

/** A stored model key. The key itself never leaves the server; `hint` is its last characters. */
export const ApiKey = z.object({
  id: z.string(),
  provider: ProviderId,
  label: z.string(),
  hint: z.string(),
  /** "user": the caller's own key. "instance": shared by admins with every project on the server. */
  scope: z.enum(["user", "instance"]),
  createdAt: z.iso.datetime(),
});
export type ApiKey = z.infer<typeof ApiKey>;

export const CreateApiKeyInput = z.object({
  provider: ProviderId,
  label: z.string().trim().min(1).max(80),
  key: z.string().trim().min(8).max(500),
  scope: z.enum(["user", "instance"]).default("user"),
});
export type CreateApiKeyInput = z.input<typeof CreateApiKeyInput>;

/** null fields fall back to the server default. */
/**
 * Where a project's tasks run. auto: on the person's computer when the
 * project has a local folder and that computer is online, otherwise in the
 * cloud sandbox. local / cloud: always there.
 */
export const TaskTarget = z.enum(["auto", "local", "cloud"]);
export type TaskTarget = z.infer<typeof TaskTarget>;

/**
 * The CLI cloud turns run with in the thread's sandbox. Claude Code needs an Anthropic model and
 * Codex an OpenAI-compatible one; with another model the turn runs with OpenCode and says so.
 */
export const CloudCli = z.enum(["opencode", "claude", "codex"]);
export type CloudCli = z.infer<typeof CloudCli>;

/** A project's default model and effort for one CLI; null: the CLI's own default. */
export const CliModelDefault = z.object({
  model: z.string().trim().min(1).max(200).nullable(),
  effort: z.string().trim().min(1).max(20).nullable(),
});
export type CliModelDefault = z.infer<typeof CliModelDefault>;

/** Defaults per CLI for the project's threads on a computer, keyed by CliId. */
export const CliModelDefaults = z.partialRecord(CliId, CliModelDefault);
export type CliModelDefaults = z.infer<typeof CliModelDefaults>;

export const ProjectSettings = z.object({
  name: z.string(),
  provider: ProviderId.nullable(),
  model: z.string().nullable(),
  keyId: z.string().nullable(),
  taskTarget: TaskTarget,
  /** Older servers never send them; null = first letter / accent color. */
  icon: ProjectIcon.nullable().default(null),
  color: ProjectColor.nullable().default(null),
  /** Older servers never send it. */
  cloudCli: CloudCli.default("opencode"),
  /** Older servers never send it. */
  cliModels: CliModelDefaults.default({}),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const UpdateProjectSettingsInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  provider: ProviderId.nullable().optional(),
  model: z.string().trim().max(200).nullable().optional(),
  keyId: z.string().nullable().optional(),
  taskTarget: TaskTarget.optional(),
  icon: ProjectIcon.nullable().optional(),
  color: ProjectColor.nullable().optional(),
  cloudCli: CloudCli.optional(),
  /** Replaces the defaults of the CLIs it names; a CLI with both null goes back to its own default. */
  cliModels: CliModelDefaults.optional(),
});
export type UpdateProjectSettingsInput = z.infer<typeof UpdateProjectSettingsInput>;

export const InviteRole = z.enum(["admin", "member"]);
export type InviteRole = z.infer<typeof InviteRole>;

export const Invite = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  email: z.string(),
  role: InviteRole,
  invitedBy: z.string(),
  createdAt: z.iso.datetime(),
});
export type Invite = z.infer<typeof Invite>;

export const CreateInviteInput = z.object({
  email: z.email().trim().toLowerCase(),
  role: InviteRole.default("member"),
});
export type CreateInviteInput = z.input<typeof CreateInviteInput>;

export const UpdateMemberInput = z.object({ role: ProjectRole });
export type UpdateMemberInput = z.infer<typeof UpdateMemberInput>;

export const InstanceRole = z.enum(["admin", "user"]);
export type InstanceRole = z.infer<typeof InstanceRole>;

/**
 * One-time tips in the apps, each shown once per account: `computer` offers pairing a computer after
 * the first finished thread, `decision` explains the first decision card.
 */
export const TipId = z.enum(["computer", "decision"]);
export type TipId = z.infer<typeof TipId>;

/** `GET /api/me`. */
export const Me = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: InstanceRole,
  /** Whether the person finished or hid the "Get started" list; older servers do not send it (the apps then never show the list). */
  onboarded: z.boolean().optional(),
  /** The one-time tips the person has seen or closed; older servers do not send it (the apps then show no tips). */
  tips: z.array(z.string()).optional(),
});
export type Me = z.infer<typeof Me>;

/** Server settings admins change at runtime. */
export const AdminSettings = z.object({ signUpEnabled: z.boolean() });
export type AdminSettings = z.infer<typeof AdminSettings>;

/** What ran into a failure: the server (a request, an agent, the cron) or one of the apps. */
export const ErrorSource = z.enum(["api", "agent", "cron", "web", "desktop", "mobile"]);
export type ErrorSource = z.infer<typeof ErrorSource>;

/** An app's own failure (`POST /api/account/client-errors`); no message, file or token contents. */
export const ClientErrorInput = z.object({
  platform: z.enum(["web", "desktop", "mobile"]),
  /** The screen's route pattern, e.g. "/projects/$projectId". */
  where: z.string().trim().min(1).max(200),
  name: z.string().max(100).default("Error"),
  message: z.string().max(500),
  stack: z.string().max(4000).optional(),
  version: z.string().max(40).optional(),
});
export type ClientErrorInput = z.input<typeof ClientErrorInput>;

/** A kind of failure the server ran into, counted each time it comes back (`GET /api/admin/errors`). */
export const AdminErrorGroup = z.object({
  id: z.string(),
  source: ErrorSource,
  where: z.string(),
  name: z.string(),
  message: z.string(),
  stack: z.string().nullable(),
  count: z.number().int(),
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
});
export type AdminErrorGroup = z.infer<typeof AdminErrorGroup>;

/** The first steps of the people who signed up in the last `days` days (`GET /api/admin/funnel`). */
export const AdminFunnel = z.object({
  days: z.number().int(),
  signedUp: z.number().int(),
  verified: z.number().int(),
  inProject: z.number().int(),
  /** Gave a task: the coordinator answered a message of theirs. */
  asked: z.number().int(),
  /** A thread worked for them. */
  threadRan: z.number().int(),
  pairedComputer: z.number().int(),
});
export type AdminFunnel = z.infer<typeof AdminFunnel>;

export const UpdateAdminSettingsInput = AdminSettings.partial();
export type UpdateAdminSettingsInput = z.infer<typeof UpdateAdminSettingsInput>;
