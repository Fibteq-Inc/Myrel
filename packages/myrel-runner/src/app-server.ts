import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { type TaskModel, unwrapShell } from "@myrel/protocol";
import type { ParseState } from "./clis";
import { codexLimits } from "./limits";

/**
 * A client for one turn of Codex's app server (`codex app-server`): newline-delimited JSON-RPC
 * over its stdin and stdout. Unlike `codex exec`, the app server asks before a step its sandbox
 * does not allow, so such a step can be put to the person instead of failing; and a turn can be
 * interrupted rather than killed. The process lives for one turn: the session is resumed by id
 * next time, as with exec, so a runner restart loses nothing.
 */

/** What the person was asked, in the shape of Claude Code's permission prompt (Myrel's approve_access tool). */
export type AppServerAsk = (toolName: string, input: Record<string, unknown>) => Promise<boolean>;

export type AppServerTurnOptions = {
  cwd: string;
  prompt: string;
  /** A session (Codex thread) to continue instead of starting one. */
  resume?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  /** "on-request" only when `ask` can put a step to the person; nobody can answer otherwise. */
  approvalPolicy: "never" | "on-request";
  model?: TaskModel;
  /** Config overrides for the session, as dotted keys (like `-c`). */
  config?: Record<string, unknown>;
  /** Puts a step that needs approval to the person. Without it, every such step is declined. */
  ask?: AppServerAsk;
  clientVersion: string;
};

type Message = { jsonrpc?: string; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };
type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const clip = (text: string) => text.trim().slice(0, 2000);

export class AppServerTurn {
  private nextId = 0;
  private readonly pending = new Map<number, (m: Message) => void>();
  private finished = false;
  private threadId?: string;
  private turnId?: string;
  /** Asked to stop before the turn started: interrupt it as soon as it has an id. */
  private stopping = false;
  /** Messages handed to the running turn whose answer has not come yet. */
  private readonly steering = new Set<(ok: boolean) => void>();
  /** The files each file change is about, for its approval, which names only the change. */
  private readonly changes = new Map<string, string[]>();

  constructor(
    private readonly io: { write(line: string): void; end(): void },
    private readonly opts: AppServerTurnOptions,
    private readonly state: ParseState,
  ) {}

  start(): void {
    this.call("initialize", { clientInfo: { name: "myrel-runner", title: "Myrel", version: this.opts.clientVersion } }, () => {
      this.send({ jsonrpc: "2.0", method: "initialized" });
      const { cwd, resume, sandbox, approvalPolicy, model, config } = this.opts;
      const params = { cwd, sandbox, approvalPolicy, ...(model?.model && { model: model.model }), ...(config && { config }) };
      if (resume) this.call("thread/resume", { ...params, threadId: resume }, (r) => this.opened(r));
      else this.call("thread/start", params, (r) => this.opened(r));
    });
  }

  /** Ends the running turn the way Codex's own Stop does; the session stays whole for the next one. */
  interrupt(): boolean {
    if (this.finished) return false;
    this.stopping = true;
    if (this.threadId && this.turnId) this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }, () => {});
    return true;
  }

  /**
   * Adds people's new message to the running turn (`turn/steer`): Codex reads it before its next step,
   * without the turn stopping. False when there is no running turn to take it.
   */
  steer(text: string): Promise<boolean> {
    const { threadId, turnId } = this;
    if (this.finished || this.stopping || !threadId || !turnId) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        this.steering.delete(done);
        resolve(ok);
      };
      // The turn may end before Codex answers; finish() answers false then.
      this.steering.add(done);
      this.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text }] }, (m) => done(!m.error));
    });
  }

  /** One line of the app server's stdout. */
  receive(line: string): void {
    if (!line.startsWith("{")) return;
    let m: Message;
    try {
      m = JSON.parse(line) as Message;
    } catch {
      return;
    }
    // Its own requests can have id 0.
    if (m.method && m.id !== undefined) return void this.answer(m);
    if (m.method) return this.notified(m.method, obj(m.params));
    if (typeof m.id === "number") {
      const handler = this.pending.get(m.id);
      this.pending.delete(m.id);
      handler?.(m);
    }
  }

  private opened(result: unknown) {
    const thread = obj(obj(result).thread);
    const id = str(thread.id);
    if (!id) return this.fail("Codex started no session.");
    this.threadId = id;
    this.state.sessionId = id;
    const model = str(obj(result).model) ?? str(thread.model);
    if (model) this.state.model = model;
    const effort = this.opts.model?.effort;
    this.call("turn/start", { threadId: id, input: [{ type: "text", text: this.opts.prompt }], ...(effort && { effort }) }, (r) => {
      this.turnId = str(obj(obj(r).turn).id);
      if (this.stopping) this.interrupt();
    });
  }

  private notified(method: string, p: Obj) {
    // Other threads' events (a subagent's) are not this turn's.
    if (this.threadId && p.threadId !== undefined && p.threadId !== this.threadId) return;
    switch (method) {
      case "item/started":
      case "item/completed":
        return this.item(method, obj(p.item));
      case "thread/tokenUsage/updated": {
        // `last` is one model call; `total` also holds the session's earlier turns.
        const last = obj(obj(p.tokenUsage).last);
        const u = (this.state.usage ??= { inputTokens: 0, outputTokens: 0 });
        u.inputTokens += count(last.inputTokens);
        u.outputTokens += count(last.outputTokens);
        return;
      }
      case "account/rateLimits/updated": {
        const limits = appServerLimits(p.rateLimits);
        if (limits) this.state.limits = limits;
        return;
      }
      case "model/rerouted": {
        const model = str(p.toModel) ?? str(p.model);
        if (model) this.state.model = model;
        return;
      }
      case "error": {
        // Codex also reports errors it recovers from ("Reconnecting... 1/5"); only a failed turn fails the run.
        const message = str(obj(p.error).message);
        if (message) this.state.error = message;
        return;
      }
      case "turn/completed":
        return this.completed(obj(p.turn));
    }
  }

  private item(method: string, item: Obj) {
    switch (item.type) {
      case "commandExecution": {
        if (method !== "item/started") return;
        const action = str(obj((item.commandActions as unknown[] | undefined)?.[0]).command);
        const command = action ?? unwrapShell(str(item.command) ?? "");
        if (command) this.state.progress = clip(`$ ${command}`);
        return;
      }
      case "fileChange": {
        const paths = Array.isArray(item.changes) ? item.changes.map((c) => str(obj(c).path)).filter((p): p is string => !!p) : [];
        if (typeof item.id === "string" && paths.length) this.changes.set(item.id, paths);
        if (method === "item/started" && paths.length) this.state.progress = clip(`Edit ${paths.join(", ")}`);
        return;
      }
      case "mcpToolCall":
        if (method === "item/started") this.state.progress = clip(`${str(item.server) ?? "mcp"}.${str(item.tool) ?? "tool"}`);
        return;
      case "webSearch":
        if (method === "item/started" && str(item.query)) this.state.progress = clip(`Search ${str(item.query)}`);
        return;
      case "agentMessage": {
        const text = str(item.text)?.trim();
        if (method !== "item/completed" || !text) return;
        // The last message is the answer, as with exec.
        this.state.progress = clip(text);
        this.state.result = text;
        return;
      }
    }
  }

  private completed(turn: Obj) {
    if (this.turnId && turn.id !== undefined && turn.id !== this.turnId) return;
    const status = turn.status;
    if (status !== "completed") {
      this.state.failed = true;
      const message = str(obj(turn.error).message) ?? this.state.error;
      if (status === "interrupted") this.state.result ??= "Codex stopped.";
      else this.state.result = message ?? `Codex ended the turn: ${String(status)}.`;
    } else this.state.failed = false;
    this.finish();
  }

  /** The app server's own requests: approvals go to the person when someone can answer; the rest is declined. */
  private async answer(m: Message) {
    const p = obj(m.params);
    const reply = (result: unknown) => this.send({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "item/commandExecution/requestApproval": {
        const action = str(obj((p.commandActions as unknown[] | undefined)?.[0]).command);
        const command = action ?? unwrapShell(str(p.command) ?? "");
        const ok = !!command && (await this.ask("Bash", { command, ...(str(p.reason) && { description: str(p.reason) }) }));
        return reply({ decision: ok ? "accept" : "decline" });
      }
      case "item/fileChange/requestApproval": {
        const paths = [...(str(p.grantRoot) ? [str(p.grantRoot)!] : []), ...(this.changes.get(String(p.itemId)) ?? [])];
        let ok = paths.length > 0;
        for (const path of paths) if (ok) ok = await this.ask("Edit", { file_path: path });
        return reply({ decision: ok ? "accept" : "decline" });
      }
      case "item/permissions/requestApproval": {
        // More folders or the network for the rest of the turn: each folder is asked about like a file outside the project.
        const wanted = obj(p.permissions);
        const fs = obj(wanted.fileSystem);
        const paths = [...((fs.write as unknown[]) ?? []), ...((fs.read as unknown[]) ?? [])].filter((x): x is string => typeof x === "string");
        const network = obj(wanted.network).enabled === true;
        let ok = paths.length > 0 || network;
        for (const path of paths) if (ok) ok = await this.ask("Edit", { file_path: path });
        if (ok && network) ok = await this.ask("Bash", { command: str(p.reason) ?? "network access" });
        return reply({ permissions: ok ? wanted : {}, scope: "turn" });
      }
      case "mcpServer/elicitation/request":
        return reply({ action: "decline" });
      case "applyPatchApproval":
      case "execCommandApproval":
        return reply({ decision: "denied" });
      default:
        return this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `${m.method} is not offered by myrel-runner` } });
    }
  }

  private async ask(toolName: string, input: Record<string, unknown>): Promise<boolean> {
    if (!this.opts.ask || this.finished) return false;
    return this.opts.ask(toolName, input).catch(() => false);
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

  /** Ends the app server's stdin, which ends the process. */
  private finish() {
    if (this.finished) return;
    this.finished = true;
    for (const done of [...this.steering]) done(false);
    this.io.end();
  }

  private send(m: Message) {
    if (this.finished) return;
    this.io.write(`${JSON.stringify(m)}\n`);
  }
}

/** The app server's rate limits ({ primary, secondary }, camelCase) as Myrel's limits. */
export function appServerLimits(rateLimits: unknown) {
  const r = obj(rateLimits);
  const window = (w: unknown) => {
    const x = obj(w);
    if (!Object.keys(x).length) return null;
    return { used_percent: x.usedPercent, window_minutes: x.windowDurationMins, resets_at: x.resetsAt };
  };
  return codexLimits({ primary: window(r.primary), secondary: window(r.secondary) }, new Date().toISOString());
}

/** How long one question to the person may take: Myrel waits up to 10 minutes for an answer. */
const ASK_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Asks through the thread's approve_access tool on Myrel's MCP endpoint, the permission prompt
 * Claude Code uses: Myrel puts the step to the person as a card and answers once they did. Plain
 * http(s) rather than fetch, whose response headers time out after 5 minutes.
 */
export function approveAccess(url: string, token: string): AppServerAsk {
  return (toolName, input) =>
    new Promise((resolve) => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "approve_access", arguments: { tool_name: toolName, input } } });
      const request = url.startsWith("https:") ? httpsRequest : httpRequest;
      const req = request(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}`, "content-length": Buffer.byteLength(body) },
          timeout: ASK_TIMEOUT_MS,
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            if (text.length < 1_000_000) text += chunk;
          });
          res.on("end", () => resolve(res.statusCode === 200 && allowed(text)));
          res.on("error", () => resolve(false));
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(false));
      req.end(body);
    });
}

/** Whether approve_access's answer ({ behavior: "allow" | "deny" } as the tool's text) allows the step. */
function allowed(text: string): boolean {
  try {
    const content = obj(obj(JSON.parse(text)).result).content;
    const answer = Array.isArray(content) ? str(obj(content[0]).text) : undefined;
    return !!answer && obj(JSON.parse(answer)).behavior === "allow";
  } catch {
    return false;
  }
}
