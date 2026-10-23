import type { ParseState } from "./clis";

/**
 * A minimal Agent Client Protocol client (https://agentclientprotocol.com) for one turn: newline-
 * delimited JSON-RPC over the CLI's stdin and stdout. The runner offers no file system or terminal of
 * its own, so the agent uses its own tools; it gets the run's MCP servers with the session.
 */

/** An MCP server as ACP's session/new takes it. */
export type AcpMcpServer =
  | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

export type AcpTurnOptions = {
  cwd: string;
  prompt: string;
  mcpServers: AcpMcpServer[];
  /** A session to continue instead of starting one. */
  resume?: string;
  /** The session mode to switch to before the prompt, when the agent has modes. */
  mode?: string;
  /** Whether to allow a step the agent asks permission for. Nobody can answer mid-run, so this decides. */
  allow: boolean;
  /**
   * The title the agent gives a tool of one of the run's MCP servers, when that title starts with the
   * server's name: such tools are allowed at any access, like the other CLIs pre-approve them.
   */
  serverTools?: (server: string) => string;
  /** Session config options to set before the prompt (model, thinking level), in order. One the agent refuses is skipped. */
  config?: Array<{ id: string; value: string }>;
  /** Other folders the session may work in, for an agent that takes them. */
  dirs?: string[];
};

type Message = { jsonrpc?: string; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };

export class AcpTurn {
  private nextId = 0;
  private readonly pending = new Map<number, (m: Message) => void>();
  private finished = false;
  /** Updates before the prompt replay the session's history (session/resume, session/load): not this turn. */
  private prompting = false;

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
      if (resume) this.call("session/resume", { sessionId: resume, cwd, mcpServers }, () => this.opened(resume));
      else
        this.call("session/new", { cwd, mcpServers, ...extra }, (r) => {
          this.configured(r);
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
        if (usage) {
          const n = (v: unknown) => (typeof v === "number" && v > 0 ? Math.round(v) : 0);
          this.state.usage = { inputTokens: n(usage.inputTokens), outputTokens: n(usage.outputTokens) + n(usage.thoughtTokens) };
        }
        this.state.failed = stopReason === "refusal" || stopReason === "cancelled";
        this.state.result = (this.state.draft ?? "").trim();
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
    if (this.opts.mode) this.call("session/set_mode", { sessionId, modeId: this.opts.mode }, next);
    else next();
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
      this.state.draft = (this.state.draft ?? "") + content.text;
      if (this.state.draft.trim()) this.state.progress = this.state.draft.trim().slice(0, 2000);
    }
    // The answer is the text after the last step, like the other CLIs' last message.
    if (u.sessionUpdate === "tool_call") {
      this.state.draft = undefined;
      if (typeof u.title === "string" && u.title) this.state.progress = u.title.slice(0, 2000);
    }
  }

  /** The agent's own requests: permissions are decided by the run's access; nothing else is offered. */
  private answer(m: Message) {
    if (m.method === "session/request_permission") {
      const params = (m.params ?? {}) as { options?: unknown; toolCall?: { title?: unknown } };
      const options = (params.options ?? []) as Array<{ optionId?: unknown; kind?: unknown }>;
      const allow = this.opts.allow || this.ownTool(params.toolCall?.title);
      const pick = options.find((o) => o.kind === (allow ? "allow_once" : "reject_once"));
      const outcome = pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" };
      return this.send({ jsonrpc: "2.0", id: m.id, result: { outcome } });
    }
    this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `${m.method} is not offered by myrel-runner` } });
  }

  /** Whether a permission request is for a tool of one of the run's own MCP servers. */
  private ownTool(title: unknown): boolean {
    const { serverTools, mcpServers } = this.opts;
    return !!serverTools && typeof title === "string" && mcpServers.some((s) => title.startsWith(serverTools(s.name)));
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
