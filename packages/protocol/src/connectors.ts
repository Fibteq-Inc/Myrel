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

/** A header name such as Authorization or api-key: letters, digits, - and _, no spaces or ":". */
export const HEADER_NAME = /^[A-Za-z_][\w-]{0,99}$/;
/** Environment variable names are stricter than header names. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

/**
 * Header and variable names are a secret's label; values are never sent back. A bad name says which
 * one and why, instead of zod's bare "Invalid key in record" (a pasted "api-key: …" line, say).
 */
const secretMap = (name: RegExp, what: string, allowed: string) =>
  z.record(z.string().regex(name), z.string().max(4000), {
    error: (iss) =>
      iss.code === "invalid_key"
        ? `${what} name ${JSON.stringify(iss.input)} is not valid: use only ${allowed}, with no spaces or ":". Put the value in its own field.`
        : undefined,
  });
const SecretMap = secretMap(HEADER_NAME, "Header", "letters, digits, - and _");
const EnvMap = secretMap(ENV_NAME, "Variable", "letters, digits and _");

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
  /** Set when its address is an official catalog server's (OFFICIAL_CATALOG); changing the address drops it. */
  official: z.object({ id: z.string(), title: z.string(), iconUrl: z.string().nullable() }).nullable().default(null),
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

/**
 * Ready-made connectors the settings offer with one click. Featured ones are listed first as
 * recommended; the rest sit in the catalog under their category (they are not in the MCP Registry).
 */
export type ConnectorPreset = {
  id: string;
  name: string;
  description: string;
  /** Shown first, as recommended, and marked as Fibteq's own. */
  featured?: boolean;
  category: CatalogCategory;
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
    category: "productivity",
    transport: "http",
    url: "https://astral.fibteq.io/api/external-ai/mcp",
    auth: "oauth",
  },
  {
    id: "fibteq-flow-apps",
    name: "Fibteq Flow Apps",
    description: "Create and publish Flow apps, and grant them tables, processes and datasources.",
    featured: true,
    category: "productivity",
    transport: "http",
    url: "https://astral.fibteq.io/api/external-ai/apps/mcp",
    auth: "oauth",
  },
  { id: "sentry", name: "Sentry", description: "Errors, issues and releases.", category: "developer", transport: "http", url: "https://mcp.sentry.dev/mcp", auth: "oauth" },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Read a PostgreSQL database. Runs as a command next to the agent.",
    category: "data",
    transport: "stdio",
    // The server takes the address as an argument; a shell reads it from the variable so it stays secret.
    command: "sh",
    args: ["-c", 'exec npx -y @modelcontextprotocol/server-postgres "$DATABASE_URL"'],
    envHint: [{ name: "DATABASE_URL", placeholder: "postgres://user:password@host:5432/db" }],
    runsOn: "both",
  },
];

/** What a catalog server is for. The registry has no categories; Myrel guesses one from the name and description. */
export const CATALOG_CATEGORIES = [
  "developer",
  "productivity",
  "communication",
  "design",
  "data",
  "sales",
  "finance",
  "search",
  "ai",
  "other",
] as const;
export const CatalogCategory = z.enum(CATALOG_CATEGORIES);
export type CatalogCategory = z.infer<typeof CatalogCategory>;

/** Keywords per category, tried in order; the first category whose pattern matches wins. */
const CATEGORY_PATTERNS: [CatalogCategory, RegExp][] = [
  ["design", /\b(design|figma|canva|ui\/ux|sketch|illustrat|icon|font|color palette|image edit|photo|video edit|webflow|wix|framer)/i],
  ["communication", /\b(e-?mail|gmail|outlook|inbox|slack|discord|telegram|whatsapp|microsoft teams|messaging|sms|meeting|zoom)/i],
  ["finance", /\b(payment|invoice|billing|stripe|paypal|accounting|bookkeep|finance|financial|bank|tax|expense|payroll|crypto|wallet|blockchain|defi|trading|stock market|x402)/i],
  ["sales", /\b(crm|sales|lead|marketing|seo|ads?\b|advertis|campaign|e-?commerce|shopify|store|shop|customer|support desk|helpdesk|ticket|hubspot|salesforce|newsletter)/i],
  ["developer", /\b(github|gitlab|git\b|code|coding|developer|devops|deploy|ci\/cd|kubernetes|docker|cloud|serverless|hosting|api testing|sdk|debug|error|monitor|observab|logs?\b|vercel|netlify|railway|cloudflare|aws|azure|gcp|sentry|posthog|database|postgres|mysql|sqlite|mongo|redis|supabase|neon)/i],
  ["data", /\b(analytics|data|dataset|sql|bigquery|warehouse|spreadsheet|sheets|excel|airtable|csv|metrics|dashboard|statistic|bi\b|report)/i],
  ["search", /\b(search|scrap|crawl|browser|web page|websites?|fetch|serp|news|wikipedia|research|knowledge base|docs? lookup|documentation)/i],
  ["ai", /\b(llm|ai models?|image generat|video generat|text-to|speech|embedding|prompt|inference|openai|anthropic|gpt|hugging ?face|machine learning)/i],
  ["productivity", /\b(notes?|notion|docs?\b|document|wiki|task|todo|project|issue|linear|jira|asana|trello|monday|calendar|schedul|workflow|automation|zapier|forms?\b|pdf|files?\b|drive|storage)/i],
];

/** A catalog server's category, guessed from its name and description. */
export function guessCatalogCategory(text: string): CatalogCategory {
  return CATEGORY_PATTERNS.find(([, re]) => re.test(text))?.[0] ?? "other";
}

/**
 * A remote MCP server from the connector catalog: the official MCP Registry
 * (registry.modelcontextprotocol.io), which Myrel copies every hour. Only servers reachable over
 * streamable HTTP are listed.
 */
export const CatalogConnector = z.object({
  /** The registry name, e.g. "com.notion/mcp". */
  id: z.string(),
  title: z.string(),
  description: z.string(),
  websiteUrl: z.string().nullable(),
  iconUrl: z.string().nullable(),
  url: z.string(),
  /** "headers": the server asks for a key (headerHint names it); "oauth": it signs in, or needs nothing. */
  auth: z.enum(["oauth", "headers"]),
  headerHint: z.object({ name: z.string(), placeholder: z.string() }).nullable(),
  category: CatalogCategory,
  /** The service's own server, checked by Myrel (OFFICIAL_CATALOG); never what the server says of itself. */
  official: z.boolean(),
});
export type CatalogConnector = z.infer<typeof CatalogConnector>;

export const CatalogPage = z.object({
  connectors: z.array(CatalogConnector),
  /** Pass as `offset` for the next page; null on the last one. */
  nextOffset: z.number().nullable(),
  /** When the catalog was last copied from the registry; null before the first copy. */
  syncedAt: z.iso.datetime().nullable(),
  /** How many servers each category has (the whole catalog, not just this search). */
  categories: z.array(z.object({ id: CatalogCategory, count: z.number() })),
});
export type CatalogPage = z.infer<typeof CatalogPage>;

/**
 * Registry names of the services' own servers, shown as official and listed first in this order,
 * with their category. The registry has thousands of entries, many of them tests or unofficial
 * copies, and anyone can call their server "official", so these are checked and picked by hand:
 * add one only after confirming the service itself publishes it (its docs link to the address).
 */
export const OFFICIAL_CATALOG: { id: string; category: CatalogCategory }[] = [
  { id: "com.notion/mcp", category: "productivity" },
  { id: "app.linear/linear", category: "productivity" },
  { id: "com.atlassian/atlassian-mcp-server", category: "productivity" },
  { id: "com.figma.mcp/mcp", category: "design" },
  { id: "com.stripe/mcp", category: "finance" },
  { id: "com.canva.mcp/mcp", category: "design" },
  { id: "com.vercel/vercel-mcp", category: "developer" },
  { id: "com.gitlab/mcp", category: "developer" },
  { id: "io.github.PostHog/mcp", category: "data" },
  { id: "com.zapier/mcp", category: "productivity" },
  { id: "com.airtable/mcp", category: "data" },
  { id: "com.monday/monday.com", category: "productivity" },
  { id: "com.paypal.mcp/mcp", category: "finance" },
  { id: "com.webflow/mcp", category: "design" },
  { id: "com.wix/mcp", category: "design" },
  { id: "com.neon/mcp", category: "developer" },
  { id: "com.railway/mcp", category: "developer" },
  { id: "co.huggingface/hf-mcp-server", category: "ai" },
  { id: "com.cloudflare.mcp/mcp", category: "developer" },
  { id: "com.apify/apify-mcp-server", category: "search" },
  { id: "ai.exa/exa", category: "search" },
  { id: "com.microsoft/microsoft-learn-mcp", category: "search" },
];
export const OFFICIAL_CATALOG_IDS = OFFICIAL_CATALOG.map((p) => p.id);
