import type { ParseState } from "./clis";
import { endAgent, startAgent, step } from "./subagents";

/**
 * A minimal Agent Client Protocol client (https://agentclientprotocol.com) for one turn: newline-
 * delimited JSON-RPC over the CLI's stdin and stdout. The runner offers no file system or terminal of
 * its own, so the agent uses its own tools; it gets the run's MCP servers with the session.
 */

/** An MCP server as ACP's session/new takes it. */
export type AcpMcpServer =
  | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

/** A tool call as the agent reports it, its updates merged in. */
export type AcpToolCall = { title?: string; kind?: string; status?: string; rawInput?: Record<string, unknown>; _meta?: unknown };

/** A subagent a tool call starts: its name, what it is for, and whether it runs on after the call returns. */
export type AcpSubagent = { label: string; purpose: string; background: boolean };

export type AcpTurnOptions = {
  cwd: string;
  prompt: string;
  mcpServers: AcpMcpServer[];
  /** A session to continue instead of starting one. */
  resume?: string;
  /**
   * The session mode to switch to before the prompt, when the agent has modes. Several: the first one
   * the session lists, for an agent whose versions name their modes differently (Qwen Code).
   */
  mode?: string | string[];
  /** Whether to allow a step the agent asks permission for. Nobody can answer mid-run, so this decides. */
  allow: boolean;
  /**
   * How a tool of one of the run's MCP servers begins, in the title the agent gives it or the tool name
   * in its `_meta` (Qwen Code): such tools are allowed at any access, like the other CLIs pre-approve them.
   */
  serverTools?: (server: string) => string;
  /** Session config options to set before the prompt (model, thinking level), in order. One the agent refuses is skipped. */
  config?: Array<{ id: string; value: string }>;
  /** Other folders the session may work in, for an agent that takes them. */
  dirs?: string[];
  /** The line for a tool call, when the agent's own title says too little (Qwen Code's CodeMode). */
  describe?: (call: AcpToolCall) => string | undefined;
  /** The subagent a tool call starts, if it is the agent's subagent tool. */
  subagent?: (call: AcpToolCall) => AcpSubagent | undefined;
};

type Message = { jsonrpc?: string; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };

export class AcpTurn {
  private nextId = 0;
  private readonly pending = new Map<number, (m: Message) => void>();
  private finished = false;
  /** Updates before the prompt replay the session's history (session/resume, session/load): not this turn. */
  private prompting = false;
  /** The modes the session listed when it opened, if any. */
  private modes: string[] = [];
  /** This turn's tool calls by id, with their updates merged in. */
  private readonly calls = new Map<string, AcpToolCall>();
  /** The latest tool call, whose line the progress shows. */
  private latest?: string;
  /** Subagent tool calls whose subagent runs on after the call returned; it ends with its own notice. */
  private readonly background = new Set<string>();
  /** A message ended by a notice after the last step, kept as the answer if no text follows it. */
  private message?: string;

  constructor(
    private readonly io: { write(line: string): void; end(): void },
    private readonly opts: AcpTurnOptions,
    private readonly state: ParseState,
  ) {}

  start(): void {
    this.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, (init) => {
      const { cwd, mcpServers, resume, dirs = [] } = this.opts;
      const caps = (init as { agentCapabilities?: { sessionCapabilities?: Record<string, unknown> } } | undefined)?.agentCapabilities?.sessionCapabilities;
      const extra = dirs.length && caps?.additionalDirectories ? { additionalDirectories: dirs } : {};
      if (resume)
        this.call("session/resume", { sessionId: resume, cwd, mcpServers }, (r) => {
          this.listed(r);
          this.opened(resume);
        });
      else
        this.call("session/new", { cwd, mcpServers, ...extra }, (r) => {
          this.configured(r);
          this.listed(r);
          this.opened(String((r as { sessionId?: unknown }).sessionId ?? ""));
        });
    });
  }

  /** One line of the agent's stdout. */
  receive(line: string): void {
    let m: Message;
    try {
      m = JSON.parse(line) as Message;
    } catch {
      return;
    }
    if (m.method && m.id !== undefined) return this.answer(m);
    if (m.method === "session/update") return this.update(((m.params as { update?: unknown })?.update ?? {}) as Record<string, unknown>);
    if (typeof m.id === "number") {
      const handler = this.pending.get(m.id);
      this.pending.delete(m.id);
      handler?.(m);
    }
  }

  private opened(sessionId: string) {
    if (!sessionId) return this.fail("The agent started no session.");
    this.state.sessionId = sessionId;
    const prompt = () => {
      this.prompting = true;
      this.call("session/prompt", { sessionId, prompt: [{ type: "text", text: this.opts.prompt }] }, (r) => {
        const { stopReason, usage } = (r ?? {}) as { stopReason?: unknown; usage?: Record<string, unknown> };
        // Qwen Code 1.x sends all zeros: that is no usage, not a free turn.
        const n = (v: unknown) => (typeof v === "number" && v > 0 ? Math.round(v) : 0);
        const used = usage && { inputTokens: n(usage.inputTokens), outputTokens: n(usage.outputTokens) + n(usage.thoughtTokens) };
        if (used && used.inputTokens + used.outputTokens > 0) this.state.usage = used;
        this.state.failed = stopReason === "refusal" || stopReason === "cancelled";
        this.state.result = (this.state.draft ?? "").trim() || this.message || "";
        if (this.state.failed && !this.state.result) this.state.result = `The agent stopped: ${String(stopReason)}.`;
        this.finish();
      });
    };
    // Config options one after another, then the prompt. A model or level the agent no longer has is
    // skipped: the turn runs with its default rather than not at all.
    const config = [...(this.opts.config ?? [])];
    const next = () => {
      const option = config.shift();
      if (!option) return prompt();
      this.request("session/set_config_option", { sessionId, configId: option.id, value: option.value }, (m) => {
        if (!m.error) this.configured(m.result);
        next();
      });
    };
    const mode = this.mode();
    if (mode) this.call("session/set_mode", { sessionId, modeId: mode }, next);
    else next();
  }

  /** The modes a session lists when it opens. */
  private listed(result: unknown) {
    const modes = (result as { modes?: { availableModes?: unknown } } | undefined)?.modes?.availableModes;
    if (Array.isArray(modes)) this.modes = modes.map((m: { id?: unknown }) => m?.id).filter((id): id is string => typeof id === "string");
  }

  /** The mode to switch to: of several, the first the session lists, else the first. */
  private mode(): string | undefined {
    const { mode } = this.opts;
    if (!Array.isArray(mode)) return mode;
    return mode.find((m) => this.modes.includes(m)) ?? mode[0];
  }

  /** The model a session or config change reports, as the run's model. */
  private configured(result: unknown) {
    const options = (result as { configOptions?: unknown } | undefined)?.configOptions;
    if (!Array.isArray(options)) return;
    const model = (options as Array<{ category?: unknown; currentValue?: unknown }>).find((o) => o.category === "model");
    if (typeof model?.currentValue === "string" && model.currentValue) this.state.model = model.currentValue;
  }

  private update(u: Record<string, unknown>) {
    if (!this.prompting) return;
    const content = u.content as { type?: unknown; text?: unknown } | undefined;
    if (u.sessionUpdate === "agent_message_chunk" && typeof content?.text === "string") {
      // A notice the agent puts between messages (Qwen Code: a background subagent finished) is not
      // part of the answer; it ends the message before it.
      const meta = (u._meta ?? {}) as { qwenDiscreteMessage?: unknown; backgroundTask?: { toolUseId?: unknown; status?: unknown } };
      if (meta.backgroundTask || meta.qwenDiscreteMessage) {
        this.settle();
        const id = meta.backgroundTask?.toolUseId;
        if (typeof id === "string" && this.background.has(id)) endAgent(this.state, id, meta.backgroundTask?.status !== "failed", "");
        return;
      }
      // A message becomes a line once it is whole: its first piece alone would say nothing.
      this.state.draft = (this.state.draft ?? "") + content.text;
    }
    if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") this.tool(u);
  }

  /** A message the agent finished before a step: a line of its own. The answer is the text after the last step. */
  private settle() {
    const text = this.state.draft?.trim();
    this.state.draft = undefined;
    if (!text) return;
    this.message = text;
    (this.state.lines ??= []).push(text.slice(0, 2000));
  }

  /** A tool call starting or changing: the latest step, or a subagent starting or ending. */
  private tool(u: Record<string, unknown>) {
    const id = typeof u.toolCallId === "string" ? u.toolCallId : "";
    const isNew = u.sessionUpdate === "tool_call";
    if (isNew) {
      this.settle();
      this.message = undefined;
    }
    const call: AcpToolCall = { ...(this.calls.get(id) ?? {}) };
    if (typeof u.title === "string" && u.title) call.title = u.title;
    if (typeof u.kind === "string") call.kind = u.kind;
    if (typeof u.status === "string") call.status = u.status;
    if (u.rawInput && typeof u.rawInput === "object" && Object.keys(u.rawInput).length) call.rawInput = u.rawInput as Record<string, unknown>;
    if (u._meta && typeof u._meta === "object" && !("toolLifecycle" in u._meta)) call._meta = u._meta;
    if (id) this.calls.set(id, call);

    const sub = id ? this.opts.subagent?.(call) : undefined;
    if (sub) {
      const ended = call.status === "completed" || call.status === "failed";
      // Its purpose may come only with a later update (Qwen Code 0.x); it starts once it is known or the call ends.
      if (call.rawInput || ended) startAgent(this.state, id, sub.label, sub.purpose, { background: sub.background });
      if (!ended || this.background.has(id)) return;
      const answer = toolText(u.content);
      // A subagent launched in the background ends with its own notice, not with the call.
      if (sub.background || /^(Background|Async) agent launched/.test(answer)) this.background.add(id);
      else endAgent(this.state, id, call.status === "completed", answer);
      return;
    }
    if (isNew) this.latest = id;
    // A later update can say more than the first title (Qwen Code 0.x: "ToolSearch", then "ToolSearch: select:…").
    if (id !== this.latest || (!isNew && !u.title && !u.rawInput)) return;
    const line = this.opts.describe?.(call) ?? describe(call);
    if (line) step(this.state, line.slice(0, 2000));
  }

  /** The agent's own requests: permissions are decided by the run's access; nothing else is offered. */
  private answer(m: Message) {
    if (m.method === "session/request_permission") {
      const params = (m.params ?? {}) as { options?: unknown; toolCall?: { title?: unknown; _meta?: unknown } };
      const options = (params.options ?? []) as Array<{ optionId?: unknown; kind?: unknown }>;
      const allow = this.opts.allow || this.ownTool(params.toolCall);
      const pick = options.find((o) => o.kind === (allow ? "allow_once" : "reject_once"));
      const outcome = pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" };
      return this.send({ jsonrpc: "2.0", id: m.id, result: { outcome } });
    }
    this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `${m.method} is not offered by myrel-runner` } });
  }

  /**
   * Whether a permission request is for a tool of one of the run's own MCP servers, by its title or the
   * tool name in its `_meta`: Qwen Code titles one "reply (myrel)" and names it in `_meta.toolName`
   * (0.x) or `_meta.qwen.toolName` (1.x).
   */
  private ownTool(toolCall: { title?: unknown; _meta?: unknown } | undefined): boolean {
    const { serverTools, mcpServers } = this.opts;
    if (!serverTools || !toolCall) return false;
    const meta = (toolCall._meta ?? {}) as Record<string, unknown>;
    const names = [toolCall.title, meta.toolName, ...Object.values(meta).map((v) => (v as { toolName?: unknown } | null)?.toolName)];
    return names.some((name) => typeof name === "string" && mcpServers.some((s) => name.startsWith(serverTools(s.name))));
  }

  private call(method: string, params: unknown, then: (result: unknown) => void) {
    this.request(method, params, (m) => (m.error ? this.fail(m.error.message || `${method} failed`) : then(m.result)));
  }

  private request(method: string, params: unknown, then: (m: Message) => void) {
    const id = ++this.nextId;
    this.pending.set(id, then);
    this.send({ jsonrpc: "2.0", id, method, params });
  }

  private fail(message: string) {
    this.state.failed = true;
    this.state.result = message;
    this.finish();
  }

  /** Ends the agent's stdin, which ends the ACP connection and the process. */
  private finish() {
    if (this.finished) return;
    this.finished = true;
    this.io.end();
  }

  private send(m: Message) {
    this.io.write(`${JSON.stringify(m)}\n`);
  }
}

/** A tool call's line: its title, with its main argument when the title is only the tool's name. */
function describe(call: AcpToolCall): string | undefined {
  const title = call.title?.trim();
  const input = call.rawInput ?? {};
  const detail = [input.command, input.file_path, input.absolute_path, input.path, input.pattern, input.query, input.url, input.description].find(
    (v): v is string => typeof v === "string" && !!v.trim(),
  );
  if (title && /^[\w.-]+$/.test(title) && detail) return `${title}: ${detail.trim().split("\n")[0]}`;
  return title;
}

/** The text of a tool call's content blocks. */
function toolText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { content?: { type?: unknown; text?: unknown } }) => (c?.content?.type === "text" && typeof c.content.text === "string" ? c.content.text : ""))
    .filter(Boolean)
    .join("\n");
}
