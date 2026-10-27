import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CliId, type CliLimits, type CliModel, type LineAgent, type RunnerCli, type TaskModel, unwrapShell } from "@myrel/protocol";
import type { AcpMcpServer, AcpTurn, AcpTurnOptions } from "./acp";
import type { AppServerTurn, AppServerTurnOptions } from "./app-server";
import { BRIDGE_VAR, type BridgeRun, ensureBridge } from "./bridge";
import type { ClaudeStreamTurn } from "./claude-stream";
import { type Access, childEnv } from "./config";
import { claudeLimits, readCodexLimits } from "./limits";
import { refreshPath } from "./path";
import { type AgentNote, agentUsage, endAgent, type SubAgent, startAgent, step } from "./subagents";

/** What a CLI's output told us so far. */
export type ParseState = {
  /** The latest human-readable step, e.g. "Edit src/app.ts". */
  progress?: string;
  /** The subagent `progress` comes from; absent for the agent's own steps (see subagents.ts). */
  progressAgent?: LineAgent;
  /** Subagents started this run, by the id their lines carry. */
  agents?: Map<string, SubAgent>;
  /** Subagents that started or ended since the last report. */
  agentNotes?: AgentNote[];
  /** Session id to resume this conversation later, when the CLI supports it. */
  sessionId?: string;
  /** Final answer, once the CLI printed it. */
  result?: string;
  /** True when the CLI reported a failure in its own output. */
  failed?: boolean;
  /** The last error the CLI reported, which may have been one it recovered from. */
  error?: string;
  /** Tokens the CLI reported using so far, summed. */
  usage?: { inputTokens: number; outputTokens: number };
  /** The model the CLI says it uses. */
  model?: string;
  /** Model calls already counted, for CLIs that repeat a call's usage on each of its parts. */
  counted?: Set<string>;
  /** The subscription limits the CLI reported in its output (Claude Code's rate_limit_event). */
  limits?: CliLimits;
  /** An answer still arriving in pieces, and the step it belongs to (Antigravity CLI, Muse Code). */
  draft?: string;
  draftStep?: unknown;
  /** The ACP conversation of this run, for CLIs that speak ACP (see CliAdapter.acp). */
  acp?: AcpTurn;
  /** The app server turn of this run, when Codex runs as `codex app-server` (see CliAdapter.appServer). */
  appServer?: AppServerTurn;
  /** Claude Code's streaming input of this run (see CliAdapter.streamInput). */
  claudeStream?: ClaudeStreamTurn;
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
   * Myrel's approve_access tool, which asks the person (see AgentMcp.asks). stream: the prompt goes
   * in as Claude Code's streaming input (see streamInput).
   */
  args(opts: { access: Access; resume?: string; extra?: string[]; dirs?: string[]; asks?: boolean; promptFile?: string; stream?: boolean }): string[];
  /**
   * Connects the CLI to the thread's MCP endpoint for a run as the thread's agent, so it talks
   * to people through Myrel's tools without asking for permission. `dir` is a private folder
   * for config files, deleted after the run.
   */
  agent(mcp: AgentMcp): Promise<{ args: string[]; env?: Record<string, string>; mcpServers?: AcpMcpServer[] }>;
  /** For a CLI that does not read stdin: the prompt goes in a private file, passed to args() as promptFile. */
  promptFile?: boolean;
  /** What goes on stdin for this prompt, when the CLI does not take it as plain text. */
  input?(prompt: string, access: Access): string;
  /** Feeds one line of stdout; updates `state` in place. */
  line(line: string, state: ParseState): void;
  /** Called with all of stdout when the CLI exits, for CLIs that print one JSON document. */
  end?(stdout: string, state: ParseState): void;
  /** After a run, the subscription limits the CLI saved somewhere else than its output. */
  limits?(state: ParseState): Promise<CliLimits | undefined>;
  /**
   * For CLIs that speak the Agent Client Protocol on stdin and stdout instead of taking one prompt:
   * the session mode for this access, whether to allow what the agent asks permission for, and the
   * session config for the task's model (already checked with safeModelArg). The prompt (after
   * `input`) and agent()'s mcpServers go in the session (see acp.ts).
   */
  acp?(access: Access, model?: TaskModel): Pick<AcpTurnOptions, "mode" | "allow" | "serverTools" | "config">;
  /**
   * For Codex: run `<bin> app-server` with agent()'s flags and these, instead of args(), when the
   * installed version has one (see hasAppServer). `asks`: steps the sandbox does not allow can be put
   * to the person, so the app server may ask instead of failing them.
   */
  appServer?(opts: { access: Access; dirs: string[]; asks: boolean }): Pick<AppServerTurnOptions, "sandbox" | "approvalPolicy" | "config">;
  /**
   * For Claude Code: the prompt goes in as streaming input on a stdin that stays open (see
   * claude-stream.ts), so new messages can go in mid-turn, when the installed version takes it
   * (see hasStreamInput).
   */
  streamInput?: boolean;
  /** Whether `<bin> --version` printed this CLI's version, for a binary name another tool also uses. */
  isMine?(version: string): boolean;
  /** The models the CLI lists, with the efforts each takes; undefined when it could not be asked. */
  models?(): Promise<CliModel[] | undefined>;
  /** The flags that run this model and effort, both already checked with safeModelArg. */
  modelArgs?(model: TaskModel): string[];
};

/**
 * Whether a model id or effort from the server may go on the command line. Windows runs the CLI
 * through a shell, so only plain names pass: the server sends only what the CLI listed anyway.
 */
export function safeModelArg(value: string | undefined): value is string {
  return !!value && value.length <= 200 && /^[A-Za-z0-9][\w.:/@+-]*$/.test(value);
}

/** A task's model and effort without anything unsafe; undefined when nothing is left. */
export function safeModel(model: TaskModel | undefined): TaskModel | undefined {
  const safe: TaskModel = {
    ...(safeModelArg(model?.model) && { model: model.model }),
    ...(safeModelArg(model?.effort) && { effort: model.effort }),
  };
  return safe.model || safe.effort ? safe : undefined;
}

/** The flags for a task's model and effort, leaving out anything unsafe. */
export function modelFlags(adapter: CliAdapter, model: TaskModel | undefined): string[] {
  const safe = safeModel(model);
  return safe && adapter.modelArgs ? adapter.modelArgs(safe) : [];
}

/** stdout of a short command, or null when it fails or takes too long. */
function output(bin: string, args: string[], timeout = 20_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, shell: process.platform === "win32", env: childEnv() }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/**
 * Claude Code has no list of models: its --help names the aliases that always mean the newest
 * model of a kind, and the effort levels it takes.
 */
export function parseClaudeHelp(help: string): CliModel[] | undefined {
  const text = help.replace(/\s+/g, " ");
  const aliases = helpParens(text, "--model <model>", "(e.g. ")?.match(/'[a-z0-9-]+'/g)?.map((a) => a.slice(1, -1));
  if (!aliases?.length) return undefined;
  const efforts = helpParens(text, "--effort <level>", "(")?.split(",").map((e) => e.trim()).filter(safeModelArg) ?? [];
  // Haiku takes no effort.
  return [...aliases, ...(aliases.includes("haiku") ? [] : ["haiku"])].map((id) => ({
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    efforts: id === "haiku" ? [] : efforts,
  }));
}

/** What is inside the parentheses opened by `open` in the description of `flag`, found without regexes over the help. */
function helpParens(text: string, flag: string, open: string): string | undefined {
  const at = text.indexOf(flag);
  if (at < 0) return undefined;
  const description = text.slice(at + flag.length, at + flag.length + 400);
  const start = description.indexOf(open);
  const end = start < 0 ? -1 : description.indexOf(")", start + open.length);
  return end < 0 ? undefined : description.slice(start + open.length, end);
}

/** `codex debug models`: the catalog the person's Codex uses, with each model's reasoning levels. */
export function parseCodexModels(json: string): CliModel[] | undefined {
  try {
    const { models } = JSON.parse(json) as { models?: unknown };
    if (!Array.isArray(models)) return undefined;
    const list = models.flatMap((m: Record<string, unknown>) => {
      if (typeof m.slug !== "string" || !safeModelArg(m.slug) || m.visibility === "hide") return [];
      const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
      const efforts = levels.map((l: { effort?: unknown }) => l?.effort).filter((e): e is string => typeof e === "string" && safeModelArg(e));
      return [{ id: m.slug, name: typeof m.display_name === "string" ? m.display_name : m.slug, efforts }];
    });
    return list.length ? list.slice(0, 100) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One model per line, its id first and maybe a name after a tab or " - " (Antigravity CLI, OpenCode,
 * Cursor CLI). These take no separate effort: where a model thinks more, it is its own model id.
 */
export function parseModelLines(text: string): CliModel[] | undefined {
  const list = text.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    const tab = trimmed.indexOf("\t");
    const cut = tab >= 0 ? tab : trimmed.indexOf(" - ");
    const id = cut >= 0 ? trimmed.slice(0, cut).trim() : trimmed;
    const name = cut >= 0 ? trimmed.slice(cut + (tab >= 0 ? 1 : 3)).trim() : "";
    if (!safeModelArg(id) || /^(available|fetching|loading)$/i.test(id) || id.endsWith(":")) return [];
    return [{ id, name: name || id, efforts: [] }];
  });
  return list.length ? list.slice(0, 100) : undefined;
}

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
  /** The run's skills: a Claude Code plugin folder, and the folder of skill folders inside it. */
  skills?: { plugin: string; dir: string };
  /**
   * Claude Code asks Myrel (the approve_access tool) instead of failing when a step needs
   * permission, so a step outside the project's folders waits for the person's answer.
   */
  asks?: boolean;
  access?: Access;
  /** The project's other folders, for CLIs that take them in their config rather than as flags. */
  dirs?: string[];
};

/** Claude Code's permission prompt tool on Myrel's MCP server. */
export const APPROVE_TOOL = "mcp__myrel__approve_access";

/** How long Claude Code waits on one Myrel tool call: the person may take a few minutes to answer. */
const ASK_TIMEOUT_MS = 15 * 60 * 1000;
/** How long Claude Code waits for an MCP server to start before going on without it. */
const MCP_START_TIMEOUT_MS = 10_000;

export type AgentServer =
  | { transport: "http"; name: string; url: string }
  | { transport: "stdio"; name: string; command: string; args: string[]; env: Record<string, string> };

/** Env var that carries the MCP token for CLIs that read it from the environment. */
const TOKEN_VAR = "MYREL_MCP_TOKEN";

/** Windows runs the CLI through a shell, which would split a path with spaces. */
function quotePath(path: string): string {
  return process.platform === "win32" ? `"${path}"` : path;
}

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
  args: ({ access, resume, extra = [], dirs = [], asks, stream }) => [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(stream ? ["--input-format", "stream-json", "--replay-user-messages"] : []),
    "--permission-mode",
    // Bypassing permissions would skip the question about folders outside the project, so full
    // access with Myrel asking pre-allows the rest instead (see agent()).
    // Auto mode runs the steps its classifier judges safe; what it would ask about goes to Myrel.
    { read: "plan", edit: "acceptEdits", auto: "auto", full: asks ? "acceptEdits" : "bypassPermissions" }[access],
    ...dirs.flatMap((d) => ["--add-dir", quotePath(d)]),
    ...(asks ? ["--permission-prompt-tool", APPROVE_TOOL] : []),
    ...(resume ? ["--resume", resume] : []),
    ...extra,
  ],
  async agent({ url, token, dir, connectors = [], skills, asks, access }) {
    const headers = { Authorization: `Bearer ${token}` };
    // alwaysLoad: Myrel's own tools go in the first model call. Otherwise Claude Code hides them behind
    // ToolSearch, and every turn spends a whole model call finding reply and update_plan first.
    const servers: Record<string, unknown> = { [MYREL_MCP_SERVER]: { type: "http", url, headers, alwaysLoad: true } };
    for (const c of connectors) {
      servers[c.name] =
        c.transport === "http" ? { type: "http", url: c.url, headers } : { type: "stdio", command: c.command, args: c.args, env: c.env };
    }
    const config = await privateFile(dir, "mcp.json", { mcpServers: servers });
    const allowed = [MYREL_MCP_SERVER, ...connectors.map((c) => c.name)].map((name) => `mcp__${name}`);
    // Full access: commands and the web need no question; only files outside the folders do.
    if (asks && access === "full") allowed.push("Bash", "WebFetch", "WebSearch");
    // The skills come as a plugin (myrel:<name>); their folder may be read without asking.
    const skillArgs = skills ? ["--plugin-dir", quotePath(skills.plugin), "--add-dir", quotePath(skills.dir)] : [];
    return {
      // Strict: only the servers above. With --mcp-config, `claude -p` waits for every MCP server the
      // person set up for themselves too before its first model call, up to 30s for one that hangs.
      // Pull requests go through Myrel's open_pull_request tool (the GitHub App), never the person's gh.
      args: [
        "--mcp-config",
        config,
        "--strict-mcp-config",
        "--allowedTools",
        allowed.join(","),
        "--disallowedTools",
        "Bash(gh pr create:*)",
        ...skillArgs,
      ],
      env: {
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        // A connector that hangs holds up the start for this long, not 30s. The person's own setting wins.
        ...(!process.env.MCP_TIMEOUT && { MCP_TIMEOUT: String(MCP_START_TIMEOUT_MS) }),
        ...(asks && { MCP_TOOL_TIMEOUT: String(ASK_TIMEOUT_MS) }),
      },
    };
  },
  streamInput: true,
  line(line, state) {
    const event = parseJson(line);
    if (!event) return;
    state.claudeStream?.receive(event);
    if (typeof event.session_id === "string") state.sessionId = event.session_id;
    if (event.type === "system" && typeof event.model === "string") state.model = event.model;
    if (event.type === "rate_limit_event") state.limits = claudeLimits(event.rate_limit_info, state.limits);
    // A subagent's messages name the Agent tool use that started it.
    const parent = typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id ? event.parent_tool_use_id : undefined;
    if (event.type === "assistant") {
      const message = (event.message ?? {}) as { id?: unknown; model?: unknown; usage?: unknown; content?: unknown[] };
      // A subagent may run on a smaller model; the turn's model is the agent's own.
      if (typeof message.model === "string" && !parent) state.model = message.model;
      // Each part of one model call arrives as its own event carrying the call's usage.
      if (typeof message.id === "string" && message.usage && !state.counted?.has(message.id)) {
        (state.counted ??= new Set()).add(message.id);
        const usage = claudeUsage(message.usage);
        addUsage(state, usage);
        if (parent) agentUsage(state, parent, usage.inputTokens + usage.outputTokens, typeof message.model === "string" ? message.model : undefined);
      }
      const content = message.content ?? [];
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type === "tool_use") {
          const input = (part.input ?? {}) as Record<string, unknown>;
          if (AGENT_TOOLS.has(String(part.name)) && typeof part.id === "string") {
            const label = typeof input.subagent_type === "string" ? input.subagent_type : "Agent";
            const purpose = typeof input.description === "string" ? input.description : "";
            startAgent(state, part.id, label, purpose, { background: input.run_in_background === true });
          } else step(state, describeTool(String(part.name), part.input), parent);
        } else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          step(state, clip(part.text), parent);
        }
      }
    }
    // The Agent tool's result is the subagent's answer, unless it runs in the background.
    if (event.type === "user") {
      const content = ((event.message ?? {}) as { content?: unknown }).content;
      for (const part of Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []) {
        const agent = part.type === "tool_result" && typeof part.tool_use_id === "string" ? state.agents?.get(part.tool_use_id) : undefined;
        if (agent && !agent.background) endAgent(state, part.tool_use_id as string, part.is_error !== true, resultText(part.content));
      }
    }
    // A background subagent ends with a notification naming its tool use.
    if (event.type === "system" && event.subtype === "task_notification" && typeof event.tool_use_id === "string") {
      const summary = typeof event.summary === "string" ? event.summary : "";
      endAgent(state, event.tool_use_id, event.status === "completed", summary);
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
  models: async () => parseClaudeHelp((await output("claude", ["--help"])) ?? ""),
  modelArgs: ({ model, effort }) => [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])],
};

/** Codex's sandbox for each access level: auto stays in the workspace like edit, asking about the rest where it can. */
const CODEX_SANDBOX = { read: "read-only", edit: "workspace-write", auto: "workspace-write", full: "danger-full-access" } as const;

const codex: CliAdapter = {
  id: "codex",
  bin: "codex",
  args: ({ access, resume, extra = [], dirs = [] }) => [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    CODEX_SANDBOX[access],
    ...dirs.flatMap((d) => ["--add-dir", quotePath(d)]),
    ...extra,
    // exec's own flags go before its resume subcommand, which takes the session and the prompt.
    ...(resume ? ["resume", resume] : []),
    "-",
  ],
  // Config overrides for one run; the token stays in the environment.
  agent: async ({ url, token, connectors = [], access }) => {
    // `codex exec` runs with approval policy "never": a tool that asks for approval (one that is
    // not read-only) fails instead of waiting, since nobody can answer there. People approve in
    // the thread, so Myrel's own servers and its connectors are pre-approved, like Claude Code's
    // --allowedTools.
    const approve = (name: string) => ["-c", `mcp_servers.${name}.default_tools_approval_mode="approve"`];
    const remote = (name: string, at: string) => [
      "-c",
      `mcp_servers.${name}.url=${JSON.stringify(at)}`,
      "-c",
      `mcp_servers.${name}.bearer_token_env_var=${JSON.stringify(TOKEN_VAR)}`,
      ...approve(name),
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
      args.push(...approve(c.name));
    }
    // The person's own ChatGPT apps too, unless the run may only read. A per-app setting in their
    // config.toml still wins.
    if (access && access !== "read") args.push("-c", 'apps._default.default_tools_approval_mode="approve"');
    return { args, env: { [TOKEN_VAR]: token } };
  },
  // The sandbox is as with exec; below full access, a step it does not allow is asked about in the
  // thread instead of failing. Full access has no sandbox, so nothing to ask.
  // The other folders go in the session's config, not on the command line, where a shell could split them.
  appServer: ({ access, dirs, asks }) => ({
    ...(dirs.length && { config: { "sandbox_workspace_write.writable_roots": dirs } }),
    sandbox: CODEX_SANDBOX[access],
    approvalPolicy: asks && (access === "edit" || access === "auto") ? "on-request" : "never",
  }),
  line(line, state) {
    if (state.appServer) return state.appServer.receive(line);
    const event = parseJson(line);
    if (!event) return;
    if (event.type === "thread.started" && typeof event.thread_id === "string") state.sessionId = event.thread_id;
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === "command_execution" && typeof item.command === "string") state.progress = clip(`$ ${unwrapShell(item.command)}`);
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      state.result = item.text;
      state.progress = clip(item.text);
    }
    if (event.type === "turn.completed" && event.usage) {
      const u = event.usage as Record<string, unknown>;
      addUsage(state, { inputTokens: count(u.input_tokens), outputTokens: count(u.output_tokens) });
    }
    // Codex also reports errors it recovers from this way ("Reconnecting... 1/5"), so only a failed
    // turn (or its exit code) fails the run; a turn that completes after an error is fine.
    const message = (event.error as { message?: string } | undefined)?.message ?? event.message;
    if (event.type === "error" && typeof message === "string") state.error = message;
    if (event.type === "turn.failed") {
      state.failed = true;
      state.result = typeof message === "string" ? message : state.error;
    }
    if (event.type === "turn.completed") state.failed = false;
  },
  // `codex exec --json` leaves its rate limits out; the session file it writes has them. (The app server reports them.)
  limits: (state) => readCodexLimits(state.sessionId),
  models: async () => parseCodexModels((await output("codex", ["debug", "models"])) ?? ""),
  modelArgs: ({ model, effort }) => [
    ...(model ? ["-m", model] : []),
    ...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
  ],
};

/** What Antigravity CLI is told below full access, where a step that needs approval ends the run. */
const AGY_LIMITED =
  "(myrel-runner: in this run you cannot run shell commands, open web pages or use any tool that needs approval: asking for one ends your run at once, with no answer. Read and edit the files here and use Myrel's tools. If a command is essential, say so in a reply: it needs full access on this computer, which the person sets in Myrel > Devices.)";

const antigravity: CliAdapter = {
  id: "antigravity",
  bin: "agy",
  // -p takes the prompt as its value, so the prompt comes on stdin as stream-json instead (see input).
  args: ({ access, resume, extra = [], dirs = [] }) => [
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    // Headless runs cannot ask: what the mode does not allow is declined. Its auto mode needs the
    // terminal sandbox and is missing on business accounts, so auto stays with edits like Codex.
    ...{ read: ["--mode", "plan"], edit: ["--mode", "accept-edits"], auto: ["--mode", "accept-edits"], full: ["--dangerously-skip-permissions"] }[access],
    ...dirs.flatMap((d) => ["--add-dir", quotePath(d)]),
    ...(resume ? ["--conversation", resume] : []),
    ...extra,
  ],
  // Below full access, a step that needs approval (a command, a web page) is declined and ends the
  // whole run with no answer, so the agent is told up front to keep to files and Myrel's tools.
  input: (prompt, access) => {
    const content = access === "full" ? prompt : `${prompt}\n\n${AGY_LIMITED}`;
    return `${JSON.stringify({ event: "user", message: { content } })}\n`;
  },
  // Its MCP servers come only from its global config, which holds Myrel's bridge (see bridge.ts):
  // the run's servers and token go to the bridge in a private file, never into that config.
  async agent({ url, token, dir, connectors = [], skills }) {
    await ensureBridge(MYREL_MCP_SERVER);
    const run: BridgeRun = { token, servers: [{ transport: "http", name: MYREL_MCP_SERVER, url }, ...connectors] };
    const file = await privateFile(dir, "bridge.json", run);
    // Its workspace takes in the skills' folder, so it may read them.
    return { args: skills ? ["--add-dir", quotePath(skills.dir)] : [], env: { [BRIDGE_VAR]: file.replace(/^"|"$/g, "") } };
  },
  line(line, state) {
    const event = parseJson(line);
    if (!event) return;
    if (typeof event.conversation_id === "string" && event.conversation_id) state.sessionId = event.conversation_id;
    const init = event.init as { model?: unknown } | undefined;
    if (event.event === "init" && typeof init?.model === "string") state.model = init.model;
    if (event.event === "step_update") {
      const step = (event.step_update ?? {}) as Record<string, unknown>;
      const tool = step.tool_info as { name?: unknown; parameters?: unknown } | undefined;
      if (step.step_type === "tool" && step.state === "ACTIVE") {
        const name = typeof tool?.name === "string" ? tool.name : step.tool_name;
        if (typeof name === "string") state.progress = describeTool(name, tool?.parameters);
      }
      // The answer arrives in pieces; the text so far is the latest step.
      if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
        state.draft = step.step_index === state.draftStep ? (state.draft ?? "") + step.text_delta : step.text_delta;
        state.draftStep = step.step_index;
        if (state.draft.trim()) state.progress = clip(state.draft);
      }
    }
    if (event.event === "result") {
      const result = (event.result ?? {}) as Record<string, unknown>;
      if (typeof result.conversation_id === "string" && result.conversation_id) state.sessionId = result.conversation_id;
      // The run's totals. Whether input_tokens holds the cache reads is not documented: what the total
      // has beyond the output is input either way.
      const u = (result.usage ?? {}) as Record<string, unknown>;
      const output = count(u.output_tokens) + count(u.thinking_tokens);
      const input = Math.max(count(u.input_tokens), count(u.total_tokens) - output);
      if (input || output) state.usage = { inputTokens: input, outputTokens: output };
      state.failed = result.status !== "SUCCESS";
      state.result = state.failed && typeof result.error === "string" && result.error ? result.error : typeof result.response === "string" ? result.response : "";
      // A step it had no permission for ends the run as a success with no answer; say what stopped it.
      const denied = Array.isArray(result.denied_actions) ? (result.denied_actions as Array<{ action?: unknown }>) : [];
      if (denied.length && !state.result.trim()) {
        const actions = [...new Set(denied.map((d) => String(d.action ?? "a tool")))].join(", ");
        state.failed = true;
        state.result = `Antigravity CLI stopped: a step needed the "${actions}" permission, which it cannot ask for when Myrel runs it. Set this computer's access to full in Myrel > Devices, or allow it under permissions.allow in ~/.gemini/antigravity-cli/settings.json (for example command(git)).`;
      }
    }
  },
  // Its model ids carry their thinking level (gemini-…-high), so no effort is offered on top.
  models: async () => parseModelLines((await output("agy", ["models"], 30_000)) ?? ""),
  modelArgs: ({ model }) => (model ? ["--model", model] : []),
};

/**
 * What opencode may do at each access level. They are its last permission rules, so they win over the
 * person's own for these tools. Commands are never sandboxed in opencode, so they need full access.
 */
const OPENCODE_ACCESS: Record<Access, Record<string, string>> = {
  read: { edit: "deny", bash: "deny" },
  edit: { edit: "allow", bash: "deny" },
  auto: { edit: "allow", bash: "deny" },
  full: { edit: "allow", bash: "allow" },
};

const opencode: CliAdapter = {
  id: "opencode",
  bin: "opencode",
  // `opencode run` reads the prompt from stdin when it gets no message.
  args: ({ access, resume, extra = [] }) => [
    "run",
    "--format",
    "json",
    // Full access approves whatever would ask (folders outside, the web), except what the person denied.
    ...(access === "full" ? ["--auto"] : []),
    ...(resume ? ["--session", resume] : []),
    ...extra,
  ],
  // Servers, permissions and skills for one run, in the environment: nothing goes into the person's config.
  async agent({ url, token, connectors = [], skills, access = "edit", dirs = [] }) {
    const auth = { Authorization: `Bearer {env:${TOKEN_VAR}}` };
    const servers: Record<string, unknown> = { [MYREL_MCP_SERVER]: { type: "remote", url, headers: auth, oauth: false } };
    for (const c of connectors) {
      servers[c.name] =
        c.transport === "http"
          ? { type: "remote", url: c.url, headers: auth, oauth: false }
          : { type: "local", command: [c.command, ...c.args], environment: c.env };
    }
    // Its tools are <server>_<tool>. Without an allow rule, a tool the person's config asks about is declined.
    const permission: Record<string, unknown> = { ...OPENCODE_ACCESS[access] };
    for (const name of Object.keys(servers)) permission[`${name}_*`] = "allow";
    const folders = [...dirs, ...(skills ? [skills.dir] : [])];
    if (folders.length) permission.external_directory = Object.fromEntries(folders.flatMap((d) => [[d, "allow"], [join(d, "*"), "allow"]]));
    const config = {
      mcp: servers,
      permission,
      ...(skills && { skills: { paths: [skills.dir] } }),
      // Headless, a step that would ask is declined; by default that also ends the run with no answer.
      experimental: { continue_loop_on_deny: true },
    };
    return {
      // opencode 2 runs through its background service otherwise, which ignores the run's config.
      args: opencodeServerArgs(await cliVersion("opencode")),
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), [TOKEN_VAR]: token },
    };
  },
  line(line, state) {
    const event = parseJson(line);
    if (!event) return;
    if (typeof event.sessionID === "string" && event.sessionID) state.sessionId = event.sessionID;
    const part = (event.part ?? {}) as Record<string, unknown>;
    if (event.type === "tool_use" && typeof part.tool === "string") {
      state.progress = describeTool(part.tool, (part.state as { input?: unknown } | undefined)?.input);
    }
    // The answer is the text of its last message, which may come in several parts.
    if (event.type === "text" && typeof part.text === "string" && part.text.trim()) {
      state.draft = part.messageID === state.draftStep && state.draft ? `${state.draft}\n\n${part.text}` : part.text;
      state.draftStep = part.messageID;
      state.result = state.draft;
      state.progress = clip(part.text);
    }
    // Each model call's tokens; input leaves out cache reads and writes, which Myrel counts as input.
    if (event.type === "step_finish") {
      const t = (part.tokens ?? {}) as Record<string, unknown>;
      const cache = (t.cache ?? {}) as Record<string, unknown>;
      addUsage(state, { inputTokens: count(t.input) + count(cache.read) + count(cache.write), outputTokens: count(t.output) + count(t.reasoning) });
    }
    // opencode 1 puts the message under data, opencode 2 on the error itself.
    if (event.type === "error") {
      const error = (event.error ?? {}) as { name?: unknown; message?: unknown; data?: { message?: unknown } };
      const message = [error.data?.message, error.message, error.name].find((m) => typeof m === "string" && m);
      state.failed = true;
      state.result = typeof message === "string" ? message : "opencode reported an error.";
    }
  },
  models: async () => parseModelLines((await output("opencode", ["models"])) ?? ""),
  modelArgs: ({ model }) => (model ? ["--model", model] : []),
};

/** `opencode --version` prints "1.19.4"; opencode 2 prints "opencode v2.0.28": the first number is the major. */
export function opencodeServerArgs(version: string | null): string[] {
  const major = Number(/\d+/.exec(version ?? "")?.[0] ?? 0);
  return major >= 2 ? ["--standalone"] : [];
}

/**
 * What Hermes is told below full access. Its commands cannot be switched off for one run (its toolsets
 * come from its global config), and it asks only about dangerous commands and sensitive files.
 */
const HERMES_LIMITED: Record<Access, string | null> = {
  read: "(myrel-runner: this run may only read. Do not change files or run commands that change anything: steps that need approval are declined.)",
  edit: "(myrel-runner: steps that need approval, such as dangerous commands or sensitive files, are declined in this run. Do not run commands that change anything outside this folder.)",
  auto: "(myrel-runner: steps that need approval, such as dangerous commands or sensitive files, are declined in this run. Do not run commands that change anything outside this folder.)",
  full: null,
};

/** The run's MCP servers for an ACP session. The token goes in the session over the pipe: never on disk or in the environment. */
function acpServers({ url, token, connectors = [] }: AgentMcp): AcpMcpServer[] {
  const headers = [{ name: "Authorization", value: `Bearer ${token}` }];
  const servers: AcpMcpServer[] = [{ type: "http", name: MYREL_MCP_SERVER, url, headers }];
  for (const c of connectors) {
    servers.push(
      c.transport === "http"
        ? { type: "http", name: c.name, url: c.url, headers }
        : { name: c.name, command: c.command, args: c.args, env: Object.entries(c.env).map(([name, value]) => ({ name, value })) },
    );
  }
  return servers;
}

const hermes: CliAdapter = {
  id: "hermes",
  bin: "hermes",
  // Its ACP server takes MCP servers per session; `hermes chat` runs in a shared gateway that only
  // knows the global config. The ACP server needs `hermes pm install --extra acp`.
  args: ({ extra = [] }) => ["acp", ...extra],
  acp: (access) => ({
    // Edit modes: default asks before edits (declined here), accept_edits allows edits in the workspace.
    mode: { read: "default", edit: "accept_edits", auto: "accept_edits", full: "dont_ask" }[access],
    allow: access === "full",
  }),
  input: (prompt, access) => (HERMES_LIMITED[access] ? `${prompt}\n\n${HERMES_LIMITED[access]}` : prompt),
  agent: async (mcp) => ({ args: [], mcpServers: acpServers(mcp) }),
  line: (line, state) => state.acp?.receive(line),
  // Another `hermes` (the React Native JavaScript engine) prints something else.
  isMine: (version) => version.startsWith("Hermes Agent"),
};

/**
 * What Cursor CLI may do at each access level. In its sandbox, edits and commands stay in the workspace
 * and commands get no network; what would need approval is declined and the run goes on.
 */
const CURSOR_ACCESS: Record<Access, string[]> = {
  // Plan mode leaves out MCP tools, so Myrel's reply too; ask mode reads and answers.
  read: ["--mode", "ask"],
  edit: ["--sandbox", "enabled"],
  auto: ["--sandbox", "enabled"],
  full: ["--force", "--sandbox", "disabled"],
};

const cursor: CliAdapter = {
  id: "cursor",
  // The installer links both `agent` and `cursor-agent`; only the second is surely Cursor's.
  bin: "cursor-agent",
  // With no prompt argument, print mode reads the prompt from stdin.
  args: ({ access, resume, extra = [], dirs = [] }) => [
    "-p",
    "--output-format",
    "stream-json",
    // Headless, an untrusted folder ends the run instead of asking.
    "--trust",
    ...CURSOR_ACCESS[access],
    ...dirs.flatMap((d) => ["--add-dir", quotePath(d)]),
    ...(resume ? ["--resume", resume] : []),
    ...extra,
  ],
  // Its MCP servers come from mcp.json files only; a plugin folder of the run brings its own, so
  // nothing goes into the person's ~/.cursor. The folder (and its token) is deleted after the run.
  async agent({ url, token, dir, connectors = [], skills }) {
    // Cursor names a plugin's servers plugin-<folder>-<server>.
    const plugin = join(dir, MYREL_MCP_SERVER);
    await mkdir(join(plugin, ".cursor-plugin"), { recursive: true });
    await writeFile(
      join(plugin, ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: MYREL_MCP_SERVER, description: "Myrel's tools for this run.", version: "1.0.0" }),
    );
    const headers = { Authorization: `Bearer ${token}` };
    const servers: Record<string, unknown> = { [MYREL_MCP_SERVER]: { url, headers } };
    for (const c of connectors) {
      servers[c.name] = c.transport === "http" ? { url: c.url, headers } : { command: c.command, args: c.args, env: c.env };
    }
    await privateFile(plugin, "mcp.json", { mcpServers: servers });
    // The skills' folder is a Claude Code plugin; a Cursor manifest makes it one for Cursor too.
    // (Cursor does not follow a symlinked skills folder.)
    if (skills) {
      await mkdir(join(skills.plugin, ".cursor-plugin"), { recursive: true });
      await writeFile(
        join(skills.plugin, ".cursor-plugin", "plugin.json"),
        JSON.stringify({ name: `${MYREL_MCP_SERVER}-skills`, description: "Skills added in Myrel for this run.", version: "1.0.0" }),
      );
    }
    // Headless, a tool that would ask is declined, and --force would also take commands out of the
    // sandbox. So the run gets the person's CLI config with allow rules for these servers added.
    const config = await cursorConfig(
      join(dir, "cursor-config"),
      Object.keys(servers).map((name) => `Mcp(plugin-${MYREL_MCP_SERVER}-${name}:*)`),
    );
    // --approve-mcps: a server not approved yet would be left out without asking.
    const plugins = [plugin, ...(skills ? [skills.plugin] : [])].flatMap((p) => ["--plugin-dir", quotePath(p)]);
    return { args: ["--approve-mcps", ...plugins], env: { CURSOR_CONFIG_DIR: config } };
  },
  line(line, state) {
    const event = parseJson(line);
    if (!event) return;
    if (typeof event.session_id === "string" && event.session_id) state.sessionId = event.session_id;
    if (event.type === "system" && typeof event.model === "string") state.model = event.model;
    if (event.type === "tool_call" && event.subtype === "started") {
      // One key per tool: readToolCall, shellToolCall, mcpToolCall... or function for the rest.
      const call = (event.tool_call ?? {}) as Record<string, { args?: Record<string, unknown>; name?: unknown; arguments?: unknown }>;
      const [key, value] = Object.entries(call).find(([k]) => k.endsWith("ToolCall") || k === "function") ?? [];
      const args = value?.args;
      if (key === "mcpToolCall" && typeof args?.toolName === "string") state.progress = describeTool(args.toolName, args.args);
      else if (key === "function" && typeof value?.name === "string") state.progress = describeTool(value.name, parseArgs(value.arguments));
      else if (key) state.progress = describeTool(key.replace(/ToolCall$/, ""), args);
    }
    if (event.type === "assistant") {
      const content = ((event.message as { content?: unknown[] } | undefined)?.content ?? []) as Array<Record<string, unknown>>;
      const text = content.map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : "")).join("");
      if (text.trim()) {
        state.draft = text;
        state.progress = clip(text);
      }
    }
    if (event.type === "result") {
      // Its result glues every message of the run together; the answer is the last one.
      state.result = state.draft ?? (typeof event.result === "string" ? event.result : "");
      state.failed = event.is_error === true || event.subtype !== "success";
      // Its input tokens leave out cache reads and writes, which Myrel counts as input.
      const u = (event.usage ?? {}) as Record<string, unknown>;
      const input = count(u.inputTokens) + count(u.cacheReadTokens) + count(u.cacheWriteTokens);
      if (input || count(u.outputTokens)) state.usage = { inputTokens: input, outputTokens: count(u.outputTokens) };
    }
  },
  models: async () => parseModelLines((await output("cursor-agent", ["models"])) ?? ""),
  modelArgs: ({ model }) => (model ? ["--model", model] : []),
};

/** Where Cursor CLI keeps its config (cli-config.json) and chats. */
function cursorConfigDir(): string {
  return process.env.CURSOR_CONFIG_DIR?.trim() || (process.env.XDG_CONFIG_HOME?.trim() ? join(process.env.XDG_CONFIG_HOME, "cursor") : join(homedir(), ".cursor"));
}

/**
 * A config folder for one Cursor run: the person's cli-config.json with `allow` added to its
 * permissions, and their chats folder linked in, so the thread's next turn can resume this chat.
 */
export async function cursorConfig(dir: string, allow: string[], own = cursorConfigDir()): Promise<string> {
  await mkdir(dir, { recursive: true });
  const config = ((await readFile(join(own, "cli-config.json"), "utf8").then(JSON.parse, () => null)) ?? { version: 1 }) as Record<string, unknown>;
  const permissions = (config.permissions ?? {}) as { allow?: unknown; deny?: unknown };
  config.permissions = { ...permissions, allow: [...(Array.isArray(permissions.allow) ? permissions.allow : []), ...allow] };
  await writeFile(join(dir, "cli-config.json"), JSON.stringify(config), { mode: 0o600 });
  // A junction on Windows needs no admin rights. Without the link the run still works, as a new chat.
  await mkdir(join(own, "chats"), { recursive: true })
    .then(() => symlink(join(own, "chats"), join(dir, "chats"), process.platform === "win32" ? "junction" : "dir"))
    .catch(() => {});
  return dir;
}

/**
 * What Muse Code may do at each access level. With approval "never" nothing waits for an answer: MCP tools
 * run, and below full its sandbox keeps writes in the workspace (and /tmp) while the run goes on.
 */
const MUSE_ACCESS: Record<Access, string[]> = {
  // Its read-only profile waits forever on a command's approval, so read takes the write and shell tools away.
  read: ["--approval-mode", "never", "--disable-write", "--disable-shell"],
  // Trust loads the folder's own rules and skills (AGENTS.md); it is not saved.
  edit: ["--approval-mode", "never", "--trust-workspace"],
  auto: ["--approval-mode", "never", "--trust-workspace"],
  full: ["--yolo"],
};

/** Env var that carries the Authorization header for Muse Code, which takes a secret only as a whole `${VAR}`. */
const MUSE_AUTH_VAR = "MYREL_MCP_AUTH";

const muse: CliAdapter = {
  id: "muse",
  bin: "muse",
  // `muse exec` does not read stdin; the prompt comes in a file.
  promptFile: true,
  args: ({ access, resume, extra = [], promptFile }) => [
    "exec",
    "--json",
    ...MUSE_ACCESS[access],
    ...(resume ? ["--session-id", resume] : []),
    ...extra,
    ...(promptFile ? ["--prompt-file", quotePath(promptFile)] : []),
  ],
  // Servers for one run as -c overrides: nothing goes into the person's settings.json. Secrets stay in the
  // environment, since -c takes them only as a whole `${VAR}`.
  async agent({ url, token, connectors = [] }) {
    const env: Record<string, string> = { [MUSE_AUTH_VAR]: `Bearer ${token}` };
    const headers = { Authorization: `\${${MUSE_AUTH_VAR}}` };
    // Its HTTP servers have no `type`: one with a type is refused as an unknown setting.
    const servers: Array<[string, unknown]> = [[MYREL_MCP_SERVER, { url, headers }]];
    for (const [i, c] of connectors.entries()) {
      if (c.transport === "http") {
        servers.push([c.name, { url: c.url, headers }]);
        continue;
      }
      const vars = Object.entries(c.env).map(([key, value], j) => {
        const name = `MYREL_MCP_${i}_${j}`;
        env[name] = value;
        return [key, `\${${name}}`];
      });
      servers.push([c.name, { command: c.command, args: c.args, env: Object.fromEntries(vars) }]);
    }
    // The whole mcpServers map cannot be set at once, only one server at a time.
    return { args: servers.flatMap(([name, server]) => ["-c", `mcpServers.${name}=${JSON.stringify(server)}`]), env };
  },
  line(line, state) {
    const event = parseJson(line);
    if (!event) return;
    const stream = event.stream as { kind?: unknown; id?: unknown } | undefined;
    if (stream?.kind === "session" && typeof stream.id === "string" && stream.id) state.sessionId = stream.id;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.payload_type) {
      case "run.model.configured":
        if (typeof p.model_id === "string") state.model = p.model_id;
        break;
      case "task.lifecycle.proposed": {
        // A tool call starts; the answer so far was said before it.
        const kind = (p.event as { task_kind?: unknown } | undefined)?.task_kind;
        if (typeof kind === "string" && kind.startsWith("tool.")) {
          state.progress = describeTool(kind.slice("tool.".length), undefined);
          state.draft = undefined;
        }
        break;
      }
      case "tool.result": {
        // Only the result says what a command or edit was about.
        const tool = (p.correlation_facts as { tool_name?: unknown } | undefined)?.tool_name;
        const edit = p.edit_facts as { path?: unknown } | undefined;
        const command = typeof p.text === "string" && p.text.startsWith("{") ? (parseArgs(p.text) as { command?: unknown } | undefined)?.command : undefined;
        if (typeof command === "string") state.progress = clip(`$ ${unwrapShell(command)}`);
        else if (typeof tool === "string") state.progress = describeTool(tool, edit);
        break;
      }
      case "run.output.delta":
        if (typeof p.text === "string") {
          state.draft = (state.draft ?? "") + p.text;
          if (state.draft.trim()) state.progress = clip(state.draft);
        }
        break;
      case "run.usage": {
        // The run's totals per model; input already holds the cached tokens.
        const models = Array.isArray(p.models) ? (p.models as Array<Record<string, unknown>>) : [];
        const input = models.reduce((n, m) => n + count(m.input_tokens), 0);
        const output = models.reduce((n, m) => n + count(m.output_tokens), 0);
        if (input || output) state.usage = { inputTokens: input, outputTokens: output };
        break;
      }
      default:
        if (typeof event.payload_type === "string" && event.payload_type.startsWith("run.terminal.")) {
          state.failed = p.terminal !== "completed";
          const text = typeof p.text === "string" ? p.text : "";
          const reason = typeof p.reason === "string" ? p.reason : "";
          state.result = state.failed ? text || reason || `Muse Code stopped (${String(p.terminal ?? "failed")}).` : text || state.draft || "";
        }
    }
  },
  // Other tools are called muse too.
  isMine: (version) => version.startsWith("Muse Code"),
  models: () => readMuseModels(),
  modelArgs: ({ model, effort }) => [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])],
};

/**
 * Muse Code has no command that lists its models; it keeps the provider's catalog, with each model's
 * effort tiers, in <data>/muse/model-catalog/*.json.
 */
async function readMuseModels(): Promise<CliModel[] | undefined> {
  const dir = join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "muse", "model-catalog");
  const files = await readdir(dir).catch(() => [] as string[]);
  const lists = await Promise.all(
    files.filter((f) => f.endsWith(".json")).map((f) => readFile(join(dir, f), "utf8").then(parseMuseCatalog, () => undefined)),
  );
  const seen = new Set<string>();
  const models = lists.flatMap((l) => l ?? []).filter((m) => !seen.has(m.id) && seen.add(m.id));
  return models.length ? models : undefined;
}

/** One catalog file: the models it shows (hidden ones are variants such as contributor mode). */
export function parseMuseCatalog(json: string): CliModel[] | undefined {
  try {
    const { rows } = JSON.parse(json) as { rows?: unknown };
    if (!Array.isArray(rows)) return undefined;
    return rows.flatMap((r: Record<string, unknown>) => {
      if (typeof r.model_id !== "string" || !safeModelArg(r.model_id) || r.visibility === "hidden") return [];
      const tiers = Array.isArray(r.reasoning_effort_variants) ? (r.reasoning_effort_variants as Array<{ tier?: unknown }>) : [];
      const efforts = tiers.map((t) => t?.tier).filter((t): t is string => typeof t === "string" && safeModelArg(t));
      const name = typeof r.display_label === "string" && r.display_label ? r.display_label : r.model_id;
      return [{ id: r.model_id, name, efforts }];
    });
  } catch {
    return undefined;
  }
}

/**
 * What Kimi Code is told below full access. Nobody can answer its approval questions mid-run, so they
 * are declined; it has no sandbox to keep commands in the folder instead.
 */
const KIMI_LIMITED: Record<Access, string | null> = {
  read: "(myrel-runner: this run may only read. Do not change files, run commands that change anything, write a plan file or call ExitPlanMode: steps that need approval are declined. Answer with Myrel's tools.)",
  edit: "(myrel-runner: in this run shell commands and edits outside this folder's git repository are declined, as is anything else that needs approval. Read and edit the files here and use Myrel's tools. If a command is essential, say so in a reply: it needs full access on this computer, which the person sets in Myrel > Devices.)",
  auto: "(myrel-runner: in this run shell commands and edits outside this folder's git repository are declined, as is anything else that needs approval. Read and edit the files here and use Myrel's tools. If a command is essential, say so in a reply: it needs full access on this computer, which the person sets in Myrel > Devices.)",
  full: null,
};

const kimi: CliAdapter = {
  id: "kimi",
  bin: "kimi",
  // `kimi -p` takes MCP servers only from the person's own config; its ACP server takes them per session.
  args: ({ extra = [] }) => ["acp", ...extra],
  acp: (access, model) => ({
    // default: reads, and edits inside the folder's git repository, run; the rest asks (declined here).
    // plan: no edits but its plan file. auto ("never ask"): everything but what the person's config denies.
    // Its yolo mode asks only about system commands (shutdown, mkfs): no sandbox, so auto stays with edit.
    mode: { read: "plan", edit: "default", auto: "default", full: "auto" }[access],
    allow: access === "full",
    // Its MCP tools are mcp__<server>__<tool>, and it asks about each: the run's own servers are allowed.
    serverTools: (server) => `mcp__${server}__`,
    config: [
      ...(model?.model ? [{ id: "model", value: model.model }] : []),
      ...(model?.effort ? [{ id: "thinking", value: model.effort }] : []),
    ],
  }),
  input: (prompt, access) => (KIMI_LIMITED[access] ? `${prompt}\n\n${KIMI_LIMITED[access]}` : prompt),
  agent: async (mcp) => ({ args: [], mcpServers: acpServers(mcp) }),
  line: (line, state) => state.acp?.receive(line),
  // Kimi Code prints its bare version; the archived Python kimi-cli prints "kimi, version …" and has no per-session MCP.
  isMine: (version) => /^v?\d+\.\d+/.test(version),
  models: async () => parseKimiModels((await output("kimi", ["provider", "list", "--json"])) ?? ""),
};

/**
 * `kimi provider list --json`: the model aliases the person set up or got with their login, with the
 * thinking levels each takes. The providers next to them (with their keys) are left alone.
 */
export function parseKimiModels(json: string): CliModel[] | undefined {
  try {
    const { models } = JSON.parse(json) as { models?: unknown };
    if (!models || typeof models !== "object") return undefined;
    const list = Object.entries(models as Record<string, Record<string, unknown>>).flatMap(([id, m]) => {
      if (!safeModelArg(id) || !m || typeof m !== "object") return [];
      const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
      const thinks = caps.some((c) => c === "thinking" || c === "always_thinking");
      const levels = thinks && Array.isArray(m.supportEfforts) ? m.supportEfforts : [];
      const efforts = levels.filter((e): e is string => typeof e === "string" && e !== "off" && safeModelArg(e));
      const name = [m.displayName, m.model].find((n): n is string => typeof n === "string" && !!n) ?? id;
      return [{ id, name, efforts }];
    });
    return list.length ? list.slice(0, 100) : undefined;
  } catch {
    return undefined;
  }
}

export const ADAPTERS: Record<CliId, CliAdapter> = { claude, codex, antigravity, opencode, hermes, cursor, muse, kimi };

/** How long `<bin> --version` may take: a first start on Windows, behind a virus scan, can be slow. */
const VERSION_TIMEOUT = process.platform === "win32" ? 30_000 : 10_000;

/** The first line `<bin> --version` prints, or null when it does not run. */
function cliVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: VERSION_TIMEOUT, shell: process.platform === "win32", env: childEnv() }, (err, stdout) => {
      resolve(err ? null : firstLine(stdout) || null);
    });
  });
}

/** Whether each Codex version has an app server, by version. */
const appServers = new Map<string, Promise<boolean>>();

/**
 * Whether `<bin> app-server` runs on this computer's Codex, asked once per version. Older versions
 * have none; MYREL_CODEX_EXEC=1 keeps `codex exec` for everyone.
 */
export async function hasAppServer(bin: string): Promise<boolean> {
  if (process.env.MYREL_CODEX_EXEC === "1") return false;
  const version = await cliVersion(bin);
  if (!version) return false;
  let known = appServers.get(version);
  if (!known) {
    known = output(bin, ["app-server", "--help"], 10_000).then((help) => !!help?.includes("--listen"));
    appServers.set(version, known);
  }
  return known;
}

/** Whether each Claude Code version takes streaming input, by version. */
const streamInputs = new Map<string, Promise<boolean>>();

/**
 * Whether this computer's Claude Code takes streaming input with echoes, asked once per version.
 * MYREL_CLAUDE_ONESHOT=1 keeps the prompt on a stdin that ends at once, as before.
 */
export async function hasStreamInput(bin: string): Promise<boolean> {
  if (process.env.MYREL_CLAUDE_ONESHOT === "1") return false;
  const version = await cliVersion(bin);
  if (!version) return false;
  let known = streamInputs.get(version);
  if (!known) {
    known = output(bin, ["--help"], 10_000).then((help) => !!help?.includes("--replay-user-messages"));
    streamInputs.set(version, known);
  }
  return known;
}

/** A CLI that was not found, and what running it said. */
export type MissingCli = { id: CliId; reason: string };

/**
 * Which CLIs are installed, by running `<bin> --version`. The PATH is looked at again first
 * (see refreshPath), so a CLI installed while the runner runs is found on the next look.
 */
export async function detectClis(missing?: MissingCli[]): Promise<RunnerCli[]> {
  await refreshPath().catch(() => {});
  const found = await Promise.all(
    Object.values(ADAPTERS).map(
      (a) =>
        new Promise<RunnerCli | null>((resolve) => {
          execFile(a.bin, ["--version"], { timeout: VERSION_TIMEOUT, shell: process.platform === "win32", env: childEnv(), windowsHide: true }, (err, stdout, stderr) => {
            if (err || (a.isMine && !a.isMine(firstLine(stdout)))) {
              missing?.push({ id: a.id, reason: err ? missingReason(err, stderr) : `\`${a.bin} --version\` printed "${firstLine(stdout)}"` });
              return resolve(null);
            }
            resolve({ id: a.id, version: firstLine(stdout) || null });
          });
        }),
    ),
  );
  return found.filter((c): c is RunnerCli => c !== null);
}

/** Why `<bin> --version` failed, in one line. */
export function missingReason(err: Error & { code?: unknown; killed?: boolean }, stderr = ""): string {
  if (err.killed) return `no answer in ${VERSION_TIMEOUT / 1000}s`;
  if (err.code === "ENOENT") return "not on PATH";
  return firstLine(stderr) || err.message.split("\n")[0] || "failed";
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

/** A tool call's arguments, which may come as a JSON string. */
function parseArgs(args: unknown): unknown {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return undefined;
  }
}

/** Claude Code's tool for starting a subagent ("Task" in older versions). */
const AGENT_TOOLS = new Set(["Agent", "Task"]);

/** The text of a tool result: a string, or text blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => ((c as { type?: unknown }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const detail = i.command ?? i.file_path ?? i.filePath ?? i.path ?? i.pattern ?? i.description;
  return typeof detail === "string" ? clip(`${name}: ${detail}`) : name;
}

/** Progress text as the protocol takes it: whole, up to its limit. */
function clip(text: string): string {
  return text.trim().slice(0, 2000);
}

function firstLine(text: string): string {
  return (text.trim().split("\n")[0] ?? "").slice(0, 200);
}
