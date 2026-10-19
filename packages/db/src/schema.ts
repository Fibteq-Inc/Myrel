import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`)
    .$onUpdate(() => new Date()),
};

// --- Better Auth core tables (property names must match Better Auth field names) ---

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  /** Instance role: admins manage server settings and shared model keys. */
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  ...timestamps,
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// --- Altair ---

/**
 * Bring-your-own model keys. `ownerId` is a user id, or null for instance keys that admins
 * share with every project on the server. `secret` is AES-GCM ciphertext (see apps/api/src/crypto.ts);
 * `hint` is the last few characters, the only part ever shown again.
 */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    secret: text("secret").notNull(),
    hint: text("hint").notNull(),
    ...timestamps,
  },
  (t) => [index("api_keys_owner_id_idx").on(t.ownerId)],
);

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id),
  /** Model settings; null = the server default (LLM_PROVIDER / LLM_MODEL). */
  llmProvider: text("llm_provider"),
  llmModel: text("llm_model"),
  /** Key the project's agents call the model with; null = an instance key for the provider. */
  llmKeyId: text("llm_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
  /** Where tasks run: auto, local or cloud (see TaskTarget in @altair/protocol). */
  taskTarget: text("task_target").notNull().default("auto"),
  ...timestamps,
});

export const projectMembers = sqliteTable(
  "project_members",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index("project_members_user_id_idx").on(t.userId)],
);

/**
 * One row per model call. Written at call time with the price that applied then, so the
 * table doubles as the metering ledger for billing. No foreign keys on purpose: usage
 * records must outlive the projects, threads and users they mention.
 */
export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    projectId: text("project_id").notNull(),
    /** null = the coordinator's call. */
    threadId: text("thread_id"),
    /** The person whose message started the turn, when there was one. */
    userId: text("user_id"),
    agent: text("agent", { enum: ["coordinator", "thread"] }).notNull(),
    /** Groups the model calls of one agent turn. */
    turnId: text("turn_id").notNull(),
    provider: text("provider").notNull(),
    /** The model that was asked for, e.g. "firerouter/opus". */
    model: text("model").notNull(),
    /** The model the provider says answered, when it differs (routers). */
    servedModel: text("served_model"),
    /** All input tokens, cached ones included. */
    inputTokens: integer("input_tokens").notNull(),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull(),
    /** Estimated cost in millionths of a US dollar; null when the model has no known price. */
    costMicros: integer("cost_micros"),
    latencyMs: integer("latency_ms").notNull(),
  },
  (t) => [
    index("usage_events_project_created_idx").on(t.projectId, t.createdAt),
    index("usage_events_user_created_idx").on(t.userId, t.createdAt),
  ],
);

/** Pending invitations to a project. The invitee accepts after signing in with `email`. */
export const projectInvites = sqliteTable(
  "project_invites",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Stored lowercased. */
    email: text("email").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex("project_invites_project_email_idx").on(t.projectId, t.email),
    index("project_invites_email_idx").on(t.email),
  ],
);

/** Server-wide settings that admins change at runtime; they override the matching wrangler vars. */
export const instanceSettings = sqliteTable("instance_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamps.updatedAt,
});

// --- GitHub (a GitHub App; see apps/api/src/github) ---

/** A GitHub App installation on a user or organization account. `id` is GitHub's installation id. */
export const githubInstallations = sqliteTable("github_installations", {
  id: integer("id").primaryKey(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type", { enum: ["User", "Organization"] }).notNull(),
  accountAvatarUrl: text("account_avatar_url"),
  ...timestamps,
});

/** Altair users GitHub confirmed can reach an installation (checked with their GitHub sign-in). */
export const githubInstallationUsers = sqliteTable(
  "github_installation_users",
  {
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.installationId, t.userId] }), index("github_installation_users_user_id_idx").on(t.userId)],
);

/** A repository connected to a project. `repoId` is GitHub's repository id, stable across renames. */
export const projectRepos = sqliteTable(
  "project_repos",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    repoId: integer("repo_id").notNull(),
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallations.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    private: integer("private", { mode: "boolean" }).notNull(),
    addedBy: text("added_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.projectId, t.repoId] }), index("project_repos_installation_id_idx").on(t.installationId)],
);

// --- Local runners (altair-runner on the user's computer) ---

export const runners = sqliteTable(
  "runners",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** SHA-256 of the runner's secret token, hex. The token itself is only on the computer. */
    tokenHash: text("token_hash").notNull().unique(),
    /** JSON RunnerInfo from the runner's last hello (folders, CLIs, version), or null. */
    info: text("info"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [index("runners_user_id_idx").on(t.userId)],
);

/** Short-lived codes shown in the web app and typed into `altair-runner pair`. */
export const runnerPairings = sqliteTable("runner_pairings", {
  /** SHA-256 of the normalized code, hex. */
  codeHash: text("code_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: timestamps.createdAt,
});

/** The local folder (on one of the owner's runners) a project works in. One per project. */
export const projectWorkspaces = sqliteTable(
  "project_workspaces",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    cli: text("cli", { enum: ["claude", "codex", "gemini"] }).notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [index("project_workspaces_runner_id_idx").on(t.runnerId)],
);

// --- Notifications ---

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    threadId: text("thread_id"),
    kind: text("kind", { enum: ["done", "ready", "decision", "blocked", "failed"] }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    url: text("url").notNull(),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("notifications_user_created_idx").on(t.userId, t.createdAt)],
);

/** Devices that receive push: browsers (Web Push) and native apps (Expo push tokens). */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["webpush", "expo"] }).notNull(),
    /** Web Push endpoint URL, or the Expo push token. */
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh"),
    auth: text("auth"),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("push_subscriptions_user_id_idx").on(t.userId)],
);

/** Per-user delivery channels. No row = defaults (both on). */
export const notificationSettings = sqliteTable("notification_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  email: integer("email", { mode: "boolean" }).notNull().default(true),
  push: integer("push", { mode: "boolean" }).notNull().default(true),
  updatedAt: timestamps.updatedAt,
});
