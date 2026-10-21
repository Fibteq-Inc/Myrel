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
  /** When the person accepted the server's terms and privacy policy at sign-up (null: none asked). */
  termsAcceptedAt: integer("terms_accepted_at", { mode: "timestamp_ms" }),
  /** The version of those documents (ServerInfo.legal.version); a newer one can ask again. */
  termsVersion: text("terms_version"),
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

// --- Myrel ---

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
  /** Where tasks run: auto, local or cloud (see TaskTarget in @myrel/protocol). */
  taskTarget: text("task_target").notNull().default("auto"),
  /** Agents working right now (coordinator + threads), kept by ProjectAgent for the project list. */
  activeCount: integer("active_count").notNull().default(0),
  /** Open threads waiting on a person (a decision, approval or blocker), kept by ProjectAgent. */
  waitingCount: integer("waiting_count").notNull().default(0),
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
    /**
     * Whose plan the call counts against: the project's owner when it was made. Written with the
     * row, so deleting the project, or changing its key or its owner later, does not take the spend
     * off anyone's limits.
     */
    billedTo: text("billed_to"),
    /** Whether the call ran on the service's key (no key of the project's own). Set with billedTo. */
    serviceKey: integer("service_key", { mode: "boolean" }),
  },
  (t) => [
    index("usage_events_project_created_idx").on(t.projectId, t.createdAt),
    index("usage_events_user_created_idx").on(t.userId, t.createdAt),
    index("usage_events_billed_created_idx").on(t.billedTo, t.createdAt),
  ],
);

/**
 * One row per finished agent turn that ran in a cloud sandbox: how long the task ran. The
 * hosted service's plans limit sandbox time with it, and the Usage page shows it. Like
 * usage_events it has no foreign keys, so the record outlives the project and thread.
 */
export const sandboxRuns = sqliteTable(
  "sandbox_runs",
  {
    /** The task's id. */
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    threadId: text("thread_id").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }).notNull(),
    seconds: integer("seconds").notNull(),
    /** Whose plan the run counts against: the project's owner when it ran (see usageEvents.billedTo). */
    billedTo: text("billed_to"),
  },
  (t) => [index("sandbox_runs_project_ended_idx").on(t.projectId, t.endedAt), index("sandbox_runs_billed_ended_idx").on(t.billedTo, t.endedAt)],
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

/** Myrel users GitHub confirmed can reach an installation (checked with their GitHub sign-in). */
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

/**
 * Pull requests a thread's tasks opened, kept current by the GitHub webhook so
 * the thread shows their live state and its agent hears about CI and reviews.
 */
export const pullRequests = sqliteTable(
  "pull_requests",
  {
    repoId: integer("repo_id").notNull(),
    number: integer("number").notNull(),
    fullName: text("full_name").notNull(),
    installationId: integer("installation_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    url: text("url").notNull(),
    title: text("title").notNull(),
    state: text("state", { enum: ["open", "closed", "merged"] }).notNull(),
    draft: integer("draft", { mode: "boolean" }).notNull().default(false),
    headSha: text("head_sha").notNull(),
    headRef: text("head_ref").notNull(),
    checks: text("checks", { enum: ["pending", "success", "failure"] }),
    review: text("review", { enum: ["approved", "changes_requested"] }),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.repoId, t.number] }), index("pull_requests_project_id_idx").on(t.projectId, t.threadId)],
);

// --- Local runners (myrel-runner on the user's computer) ---

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

/** Short-lived codes shown in the web app and typed into `myrel-runner pair`. */
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
    /** JSON array of other folders on the same runner the agent may work in too. */
    folders: text("folders").notNull().default("[]"),
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

// ---- Hosted billing ---------------------------------------------------------
// Written only by the hosted service's billing extension (ee/billing). They stay empty on a
// self-hosted server, which has no plans or limits.

/** A person's Stripe customer. One per person; a Team plan is bought by its owner. */
export const billingCustomers = sqliteTable("billing_customers", {
  userId: text("user_id").primaryKey(),
  stripeCustomerId: text("stripe_customer_id").notNull().unique(),
  /** Set once the person started a trial, so they get only one. */
  trialUsed: integer("trial_used", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Addresses that had a trial, as a hash of the normalized address, so deleting the account and
 * signing up again with the same address does not bring another one. Outlives the account on purpose.
 */
export const billingTrials = sqliteTable("billing_trials", {
  emailHash: text("email_hash").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * A paid subscription: a Stripe one as its webhooks last described it, or an App Store / Google Play
 * one as RevenueCat last described it.
 */
export const billingSubscriptions = sqliteTable(
  "billing_subscriptions",
  {
    /** Stripe's subscription id, or `rc:<store>:<product>:<user>` for a store subscription. */
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    plan: text("plan", { enum: ["pro", "team"] }).notNull(),
    interval: text("interval", { enum: ["month", "year"] }).notNull(),
    /** Stripe's status: trialing, active, past_due, canceled, unpaid, incomplete, ... */
    status: text("status").notNull(),
    seats: integer("seats").notNull().default(1),
    currentPeriodEnd: integer("current_period_end", { mode: "timestamp_ms" }),
    trialEnd: integer("trial_end", { mode: "timestamp_ms" }),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull().default(false),
    /** When the subscription last became past_due; the plan holds for a grace period from then. */
    pastDueSince: integer("past_due_since", { mode: "timestamp_ms" }),
    /** Who bills it: Stripe (web), or Apple or Google (bought in the mobile app, through RevenueCat). */
    source: text("source", { enum: ["stripe", "app_store", "play_store"] }).notNull().default("stripe"),
    /** The store's product id, for a store subscription. */
    storeProductId: text("store_product_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("billing_subscriptions_user_idx").on(t.userId)],
);

/** The people a Team plan covers besides its owner. */
export const billingTeamMembers = sqliteTable(
  "billing_team_members",
  {
    ownerId: text("owner_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.userId] }), uniqueIndex("billing_team_members_user_idx").on(t.userId)],
);

/** Stripe webhook events already handled, so a redelivery is ignored. */
export const stripeEvents = sqliteTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
/**
 * Connectors: MCP servers the thread's agent may use (see @myrel/protocol connectors.ts). A row
 * belongs to a person (owner_id) or to a project (project_id), never both. `secret` is AES-GCM
 * ciphertext of a JSON object (headers for http, environment variables for stdio), bound to the
 * row id; `secret_names` lists its keys, the only part ever shown again.
 */
export const connectors = sqliteTable(
  "connectors",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    transport: text("transport", { enum: ["http", "stdio"] }).notNull(),
    url: text("url"),
    /** How a remote server is signed in to; "oauth" keeps the client, tokens and a pending sign-in in `secret`. */
    auth: text("auth", { enum: ["none", "headers", "oauth"] }).notNull().default("headers"),
    command: text("command"),
    args: text("args", { mode: "json" }).$type<string[]>().notNull().default([]),
    runsOn: text("runs_on", { enum: ["cloud", "local", "both"] }).notNull().default("both"),
    secret: text("secret"),
    secretNames: text("secret_names", { mode: "json" }).$type<string[]>().notNull().default([]),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    status: text("status", { enum: ["unknown", "ok", "error", "needs_auth"] }).notNull().default("unknown"),
    lastError: text("last_error"),
    tools: text("tools", { mode: "json" }).$type<{ name: string; description?: string }[]>().notNull().default([]),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("connectors_owner_slug_idx").on(t.ownerId, t.slug),
    uniqueIndex("connectors_project_slug_idx").on(t.projectId, t.slug),
  ],
);

/**
 * The connector catalog: remote MCP servers listed in the official MCP Registry
 * (registry.modelcontextprotocol.io), copied here by an hourly cron (see apps/api/src/connectors/catalog.ts)
 * so the settings can search it without calling the registry. One row per server, its latest version;
 * `id` is the registry name (e.g. "com.notion/mcp").
 */
export const connectorCatalog = sqliteTable(
  "connector_catalog",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    websiteUrl: text("website_url"),
    iconUrl: text("icon_url"),
    /** The streamable HTTP address the connector is added with. */
    url: text("url").notNull(),
    /** "headers": the server asks for a secret header (an API key); otherwise it signs in or needs nothing. */
    auth: text("auth", { enum: ["oauth", "headers"] }).notNull(),
    headerName: text("header_name"),
    headerPlaceholder: text("header_placeholder"),
    /** What it is for (CATALOG_CATEGORIES in @myrel/protocol), guessed from its name and description. */
    category: text("category").notNull().default("other"),
    version: text("version").notNull(),
    /** When the registry last changed this entry. */
    registryUpdatedAt: text("registry_updated_at").notNull(),
    syncedAt: integer("synced_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("connector_catalog_title_idx").on(t.title), index("connector_catalog_category_idx").on(t.category)],
);

/** Where the catalog sync stands: one row ("registry"). */
export const connectorCatalogSync = sqliteTable("connector_catalog_sync", {
  id: text("id").primaryKey(),
  /** Start of the last sync that finished; the next one asks the registry for changes since then. */
  since: text("since"),
  /** A sync that ran out of time continues from this page. */
  cursor: text("cursor"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Skills (Agent Skills: a SKILL.md and its files) the thread's agent may use (see @myrel/protocol
 * skills.ts). A row belongs to a person (owner_id) or to a project (project_id), never both. The
 * files live in R2 (FILES bucket) as one bundle at `skills/<id>.json`; `files` lists them.
 */
export const skills = sqliteTable(
  "skills",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    source: text("source", { mode: "json" })
      .$type<
        { kind: "write" } | { kind: "upload" } | { kind: "github"; repo: string; path: string; ref?: string; commit: string }
      >()
      .notNull(),
    files: text("files", { mode: "json" }).$type<{ path: string; size: number }[]>().notNull().default([]),
    size: integer("size").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("skills_owner_name_idx").on(t.ownerId, t.name), uniqueIndex("skills_project_name_idx").on(t.projectId, t.name)],
);

/**
 * A person's own skill or connector turned on in one project. Personal ones work only in the
 * projects listed here (and only in threads that work for that person); new ones start off.
 */
export const projectSkills = sqliteTable(
  "project_skills",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.projectId, t.skillId] }), index("project_skills_skill_idx").on(t.skillId)],
);

export const projectConnectors = sqliteTable(
  "project_connectors",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.projectId, t.connectorId] }), index("project_connectors_connector_idx").on(t.connectorId)],
);
