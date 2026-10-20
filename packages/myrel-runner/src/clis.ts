import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliId, RunnerCli } from "@myrel/protocol";
import type { Access } from "./config";

/** What a CLI's output told us so far. */
export type ParseState = {
  /** The latest human-readable step, e.g. "Edit src/app.ts". */
  progress?: string;
  /** Session id to resume this conversation later, when the CLI supports it. */
  sessionId?: string;
  /** Final answer, once the CLI printed it. */
  result?: string;
  /** True when the CLI reported a failure in its own output. */
  failed?: boolean;
  /** Tokens the CLI reported using so far, summed. */
  usage?: { inputTokens: number; outputTokens: number };
  /** The model the CLI says it uses. */
  model?: string;
  /** Model calls already counted, for CLIs that repeat a call's usage on each of its parts. */
  counted?: Set<string>;
};

/**
 * One coding CLI. Every adapter takes the prompt on stdin, so prompts never pass
 * through a shell or get mistaken for flags. Logins stay with the CLI itself.
 */
export type CliAdapter = {
  id: CliId;
  bin: string;
  /**
   * extra: flags from `agent`, placed before the CLI's own trailing arguments. dirs: other folders
   * the CLI may work in besides its current one. asks: Claude Code sends permission prompts to
   * Myrel's approve_access tool, which asks the person (see AgentMcp.asks).
   */
  args(opts: { access: Access; resume?: string; extra?: string[]; dirs?: string[]; asks?: boolean }): string[];
  /**
   * Connects the CLI to the thread's MCP endpoint for a run as the thread's agent, so it talks
   * to people through Myrel's tools without asking for permission. `dir` is a private folder
   * for config files, deleted after the run.
   */
  agent(mcp: AgentMcp): Promise<{ args: string[]; env?: Record<string, string> }>;
  /** Feeds one line of stdout; updates `state` in place. */
  line(line: string, state: ParseState): void;
  /** Called with all of stdout when the CLI exits, for CLIs that print one JSON document. */
  end?(stdout: string, state: ParseState): void;
};

/** Name of Myrel's MCP server in the CLI's config; its tools show up as mcp__myrel__<tool> in Claude Code. */
export const MYREL_MCP_SERVER = "myrel";

/**
 * The thread's MCP endpoint for one agent run, and its connectors: remote ones on the same server
 * with the same token, commands started on this computer with their own environment.
 */
export type AgentMcp = {
  url: string;
  token: string;
  dir: string;
  connectors?: AgentServer[];
  /**
   * Claude Code asks Myrel (the approve_access tool) instead of failing when a step needs
   * permission, so a step outside the project's folders waits for the person's answer.
   */
  asks?: boolean;
  access?: Access;
};

/** Claude Code's permission prompt tool on Myrel's MCP server. */
export const APPROVE_TOOL = "mcp__myrel__approve_access";

/** How long Claude Code waits on one Myrel tool call: the person may take a few minutes to answer. */
const ASK_TIMEOUT_MS = 15 * 60 * 1000;

export type AgentServer =
  | { transport: "http"; name: string; url: string }
  | { transport: "stdio"; name: string; command: string; args: string[]; env: Record<string, string> };

/** Env var that carries the MCP token for CLIs that read it from the environment. */
const TOKEN_VAR = "MYREL_MCP_TOKEN";

/** Writes a config file only this user can read: it holds the run's token. */
async function privateFile(dir: string, name: string, content: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(content), { mode: 0o600 });
  // Windows runs the CLI through a shell, which would split a path with spaces.
  return process.platform === "win32" ? `"${path}"` : path;
}

const claude: CliAdapter = {
  id: "claude",
  bin: "claude",
  args: ({ access, resume, extra = [], dirs = [], asks }) => [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    // Bypassing permissions would skip the question about folders outside the project, so full
    // access with Myrel asking pre-allows the rest instead (see agent()).
    { read: "plan", edit: "acceptEdits", full: asks ? "acceptEdits" : "bypassPermissions" }[access],
    ...dirs.flatMap((d) => ["--add-dir", d]),
    ...(asks ? ["--permission-prompt-tool", APPROVE_TOOL] : []),
    ...(resume ? ["--resume", resume] : []),
    ...extra,
  ],
  async agent({ url, token, dir, connectors = [], asks, access }) {
    const headers = { Authorization: `Bearer ${token}` };
    const servers: Record<string, unknown> = { [MYREL_MCP_SERVER]: { type: "http", url, headers } };
    for (const c of connectors) {
      servers[c.name] =
        c.transport === "http" ? { type: "http", url: c.url, headers } : { type: "stdio", command: c.command, args: c.args, env: c.env };
    }
    const config = await privateFile(dir, "mcp.json", { mcpServers: servers });
    const allowed = [MYREL_MCP_SERVER, ...connectors.map((c) => c.name)].map((name) => `mcp__${name}`);
    // Full access: commands and the web need no question; only files outside the folders do.
    if (asks && access === "full") allowed.push("Bash", "WebFetch", "WebSearch");
    return {
      args: ["--mcp-config", config, "--allowedTools", allowed.join(",")],
      ...(asks && { env: { MCP_TOOL_TIMEOUT: String(ASK_TIMEOUT_MS) } }),
    };
  },
  line(line, state) {
    const event = parseJson(line);
    if (!event) return;
    if (typeof event.session_id === "string") state.sessionId = event.session_id;
    if (event.type === "system" && typeof event.model === "string") state.model = event.model;
    if (event.type === "assistant") {
      const message = (event.message ?? {}) as { id?: unknown; model?: unknown; usage?: unknown; content?: unknown[] };
      if (typeof message.model === "string") state.model = message.model;
      // Each part of one model call arrives as its own event carrying the call's usage.
      if (typeof message.id === "string" && message.usage && !state.counted?.has(message.id)) {
        (state.counted ??= new Set()).add(message.id);
        addUsage(state, claudeUsage(message.usage));
      }
      const content = message.content ?? [];
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type === "tool_use") state.progress = describeTool(String(part.name), part.input);
        else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          state.progress = firstLine(part.text);
        }
      }
    }
    if (event.type === "result") {
      // The run's own totals, when they say more than what was summed along the way.
      if (event.usage) {
        const total = claudeUsage(event.usage);
        const sum = state.usage ?? { inputTokens: 0, outputTokens: 0 };
        state.usage = { inputTokens: Math.max(sum.inputTokens, total.inputTokens), outputTokens: Math.max(sum.outputTokens, total.outputTokens) };
      }
      state.result = typeof event.result === "string" ? event.result : "";
      state.failed = event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success");
    }
  },
};

const codex: CliAdapter = {
  id: "codex",
  bin: "codex",
  args: ({ access, extra = [], dirs = [] }) => [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    { read: "read-only", edit: "workspace-write", full: "danger-full-access" }[access],
    ...dirs.flatMap((d) => ["--add-dir", d]),
    ...extra,
    "-",
  ],
  // Config overrides for one run; the token stays in the environment.
  agent: async ({ url, token, connectors = [] }) => {
    const remote = (name: string, at: string) => [
      "-c",
      `mcp_servers.${name}.url=${JSON.stringify(at)}`,
      "-c",
      `mcp_servers.${name}.bearer_token_env_var=${JSON.stringify(TOKEN_VAR)}`,
    ];
    const args = remote(MYREL_MCP_SERVER, url);
    for (const c of connectors) {
      if (c.transport === "http") {
        args.push(...remote(c.name, c.url));
        continue;
      }
      // TOML: a JSON string array is a TOML array; the environment is an inline table.
      const env = Object.entries(c.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
      args.push("-c", `mcp_servers.${c.name}.command=${JSON.stringify(c.command)}`, "-c", `mcp_servers.${c.name}.args=${JSON.stringify(c.args)}`);
      if (env.length) args.push("-c", `mcp_servers.${c.name}.env={ ${env.join(", ")} }`);
    }
    return { args, env: { [TOKEN_VAR]: token } };
  },
  line(line, state) {
    const event = parseJson(line);
    if (!event) return;
    if (event.type === "thread.started" && typeof event.thread_id === "string") state.sessionId = event.thread_id;
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === "command_execution" && typeof item.command === "string") state.progress = `$ ${item.command}`;
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      state.result = item.text;
      state.progress = firstLine(item.text);
    }
    if (event.type === "turn.completed" && event.usage) {
      const u = event.usage as Record<string, unknown>;
      addUsage(state, { inputTokens: count(u.input_tokens), outputTokens: count(u.output_tokens) });
    }
    if (event.type === "turn.failed" || event.type === "error") {
      state.failed = true;
      const message = (event.error as { message?: string } | undefined)?.message ?? event.message;
      if (typeof message === "string") state.result = message;
    }
  },
};

const gemini: CliAdapter = {
  id: "gemini",
  bin: "gemini",
  args: ({ access, extra = [], dirs = [] }) => [
    "--output-format",
    "json",
    "--approval-mode",
    { read: "default", edit: "auto_edit", full: "yolo" }[access],
    ...(dirs.length ? ["--include-directories", dirs.join(",")] : []),
    ...extra,
  ],
  // Gemini CLI has no flag for an MCP config, so the run gets its own system settings file.
  async agent({ url, token, dir, connectors = [] }) {
    const headers = { Authorization: `Bearer ${token}` };
    const servers: Record<string, unknown> = { [MYREL_MCP_SERVER]: { httpUrl: url, headers, trust: true } };
    for (const c of connectors) {
      servers[c.name] =
        c.transport === "http" ? { httpUrl: c.url, headers, trust: true } : { command: c.command, args: c.args, env: c.env, trust: true };
    }
    const settings = await privateFile(dir, "settings.json", { mcpServers: servers });
    return { args: [], env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings.replace(/^"|"$/g, "") } };
  },
  line() {},
  end(stdout, state) {
    const doc = parseJson(stdout.trim());
    if (doc && typeof doc.response === "string") state.result = doc.response;
    // stats.models: { "<model>": { tokens: { prompt, candidates, thoughts, … } } }
    const models = (doc?.stats as { models?: Record<string, { tokens?: Record<string, unknown> }> } | undefined)?.models;
    for (const [model, m] of Object.entries(models ?? {})) {
      state.model ??= model;
      const tokens = m.tokens ?? {};
      addUsage(state, { inputTokens: count(tokens.prompt), outputTokens: count(tokens.candidates) + count(tokens.thoughts) });
    }
    if (doc?.error) {
      state.failed = true;
      state.result = String((doc.error as { message?: string }).message ?? doc.error);
    }
  },
};

export const ADAPTERS: Record<CliId, CliAdapter> = { claude, codex, gemini };

/** Which CLIs are installed, by running `<bin> --version`. */
export async function detectClis(): Promise<RunnerCli[]> {
  const found = await Promise.all(
    Object.values(ADAPTERS).map(
      (a) =>
        new Promise<RunnerCli | null>((resolve) => {
          execFile(a.bin, ["--version"], { timeout: 10_000, shell: process.platform === "win32" }, (err, stdout) => {
            resolve(err ? null : { id: a.id, version: firstLine(stdout) || null });
          });
        }),
    ),
  );
  return found.filter((c): c is RunnerCli => c !== null);
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/** Claude's input tokens leave out cache reads and writes; Myrel counts all of them as input. */
function claudeUsage(usage: unknown): { inputTokens: number; outputTokens: number } {
  const u = (usage ?? {}) as Record<string, unknown>;
  return {
    inputTokens: count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens),
    outputTokens: count(u.output_tokens),
  };
}

function addUsage(state: ParseState, add: { inputTokens: number; outputTokens: number }) {
  const u = (state.usage ??= { inputTokens: 0, outputTokens: 0 });
  u.inputTokens += add.inputTokens;
  u.outputTokens += add.outputTokens;
}

function parseJson(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const detail = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description;
  return typeof detail === "string" ? `${name}: ${firstLine(detail)}` : name;
}

function firstLine(text: string): string {
  return (text.trim().split("\n")[0] ?? "").slice(0, 200);
}
