import { z } from "zod";

/**
 * Connectors are MCP servers people add so the thread's agent can work in other services
 * (Linear, Notion, Sentry, a database…).
 * - http: a remote server. The agent reaches it through Myrel (/api/agent-mcp/:threadId/c/:slug),
 *   which adds its credentials, so they never reach the sandbox or the person's computer.
 * - stdio: a command started next to the agent, in the cloud sandbox or on the person's computer.
 *   Its environment variables are handed to that run only.
 */
export const ConnectorTransport = z.enum(["http", "stdio"]);
export type ConnectorTransport = z.infer<typeof ConnectorTransport>;

/** "user": the person's own, on in the threads that work for them. "project": shared by every thread of a project. */
export const ConnectorScope = z.enum(["user", "project"]);
export type ConnectorScope = z.infer<typeof ConnectorScope>;

/** Where a stdio server may start. A server on localhost only makes sense on the person's computer. */
export const ConnectorRunsOn = z.enum(["cloud", "local", "both"]);
export type ConnectorRunsOn = z.infer<typeof ConnectorRunsOn>;

/** needs_auth: an OAuth connector nobody has signed in to yet, or whose sign-in expired. */
export const ConnectorStatus = z.enum(["unknown", "ok", "error", "needs_auth"]);
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

/**
 * How a remote server is signed in to. headers: fixed headers (an API key). oauth: the person signs
 * in once in the browser (OAuth 2.1 with PKCE); Myrel keeps and refreshes the token.
 */
export const ConnectorAuth = z.enum(["none", "headers", "oauth"]);
export type ConnectorAuth = z.infer<typeof ConnectorAuth>;

/** Server name in the agent's config, so its tools show as mcp__<slug>__<tool>. "myrel" is Myrel's own. */
export const ConnectorSlug = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/)
  .refine((s) => s !== "myrel", "That name is taken by Myrel's own tools.");

export const ConnectorTool = z.object({ name: z.string(), description: z.string().optional() });
export type ConnectorTool = z.infer<typeof ConnectorTool>;

/** Header and variable names are a secret's label; values are never sent back. */
const SecretMap = z.record(z.string().regex(/^[A-Za-z_][\w-]{0,99}$/), z.string().max(4000));
/** Environment variable names are stricter than header names. */
const EnvMap = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/), z.string().max(4000));

export const Connector = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  scope: ConnectorScope,
  transport: ConnectorTransport,
  url: z.string().nullable(),
  auth: ConnectorAuth,
  command: z.string().nullable(),
  args: z.array(z.string()),
  runsOn: ConnectorRunsOn,
  /** Names of the stored headers (http) or environment variables (stdio). */
  secretNames: z.array(z.string()),
  enabled: z.boolean(),
  status: ConnectorStatus,
  lastError: z.string().nullable(),
  /** The tools it offered at the last check. Unknown for stdio servers until a run starts them. */
  tools: z.array(ConnectorTool),
  /** Whether the caller may change it. */
  canEdit: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Connector = z.infer<typeof Connector>;

const Name = z.string().trim().min(1).max(60);

export const CreateConnectorInput = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("http"),
    name: Name,
    slug: ConnectorSlug.optional(),
    url: z.url({ protocol: /^https$/ }).max(2000),
    /** "oauth": the answer carries a sign-in link to open. Otherwise headers decide ("none" without any). */
    auth: z.enum(["headers", "oauth"]).default("headers"),
    /** Sent with every request, e.g. { Authorization: "Bearer …" }. */
    headers: SecretMap.default({}),
  }),
  z.object({
    transport: z.literal("stdio"),
    name: Name,
    slug: ConnectorSlug.optional(),
    /** e.g. "npx" with args ["-y", "@modelcontextprotocol/server-postgres", "postgres://…"]. */
    command: z.string().trim().min(1).max(200),
    args: z.array(z.string().max(2000)).max(50).default([]),
    env: EnvMap.default({}),
    runsOn: ConnectorRunsOn.default("both"),
  }),
]);
export type CreateConnectorInput = z.input<typeof CreateConnectorInput>;

export const UpdateConnectorInput = z.object({
  name: Name.optional(),
  enabled: z.boolean().optional(),
  url: z.url({ protocol: /^https$/ }).max(2000).optional(),
  command: z.string().trim().min(1).max(200).optional(),
  args: z.array(z.string().max(2000)).max(50).optional(),
  runsOn: ConnectorRunsOn.optional(),
  /** Replaces the stored headers or variables. A name given an empty value keeps its stored value. */
  secrets: SecretMap.optional(),
});
export type UpdateConnectorInput = z.input<typeof UpdateConnectorInput>;

/** Turns a name into a server name: "Linear (work)" → "linear-work". */
export function connectorSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  const safe = /^[a-z]/.test(slug) ? slug : `mcp-${slug}`.replace(/-+$/, "");
  return safe === "myrel" ? "myrel-mcp" : safe;
}

/** Answer to adding an OAuth connector, or to asking to sign in again: open this link in the browser. */
export const ConnectorAuthorize = z.object({ authorizeUrl: z.url() });

/** Ready-made connectors the settings offer with one click. */
export type ConnectorPreset = {
  id: string;
  name: string;
  description: string;
  /** Shown first and marked as Fibteq's own. */
  featured?: boolean;
} & (
  | { transport: "http"; url: string; auth: "oauth" | "headers"; headerHint?: { name: string; placeholder: string } }
  | { transport: "stdio"; command: string; args: string[]; envHint?: { name: string; placeholder: string }[]; runsOn: ConnectorRunsOn }
);

export const CONNECTOR_PRESETS: ConnectorPreset[] = [
  {
    id: "fibteq-flow",
    name: "Fibteq Flow",
    description: "Design and start Flow workflows, forms, dashboards and reports.",
    featured: true,
    transport: "http",
    url: "https://astral.fibteq.io/api/external-ai/mcp",
    auth: "oauth",
  },
  {
    id: "fibteq-flow-apps",
    name: "Fibteq Flow Apps",
    description: "Create and publish Flow apps, and grant them tables, processes and datasources.",
    featured: true,
    transport: "http",
    url: "https://astral.fibteq.io/api/external-ai/apps/mcp",
    auth: "oauth",
  },
  { id: "linear", name: "Linear", description: "Issues, projects and cycles.", transport: "http", url: "https://mcp.linear.app/mcp", auth: "oauth" },
  { id: "notion", name: "Notion", description: "Pages and databases.", transport: "http", url: "https://mcp.notion.com/mcp", auth: "oauth" },
  { id: "sentry", name: "Sentry", description: "Errors, issues and releases.", transport: "http", url: "https://mcp.sentry.dev/mcp", auth: "oauth" },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Read a PostgreSQL database. Runs as a command next to the agent.",
    transport: "stdio",
    // The server takes the address as an argument; a shell reads it from the variable so it stays secret.
    command: "sh",
    args: ["-c", 'exec npx -y @modelcontextprotocol/server-postgres "$DATABASE_URL"'],
    envHint: [{ name: "DATABASE_URL", placeholder: "postgres://user:password@host:5432/db" }],
    runsOn: "both",
  },
];
