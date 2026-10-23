import { z } from "zod";
import { ProjectRole } from "./models";
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

/** `GET /api/me`. */
export const Me = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: InstanceRole,
  /** Whether the person finished or hid the "Get started" list; older servers do not send it (the apps then never show the list). */
  onboarded: z.boolean().optional(),
});
export type Me = z.infer<typeof Me>;

/** Server settings admins change at runtime. */
export const AdminSettings = z.object({ signUpEnabled: z.boolean() });
export type AdminSettings = z.infer<typeof AdminSettings>;

export const UpdateAdminSettingsInput = AdminSettings.partial();
export type UpdateAdminSettingsInput = z.infer<typeof UpdateAdminSettingsInput>;
