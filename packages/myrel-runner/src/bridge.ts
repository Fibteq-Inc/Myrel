import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentServer } from "./clis";

/**
 * Antigravity CLI takes MCP servers only from its global config (or a file in the project folder),
 * never for one run. So that config holds one fixed server, `myrel-runner mcp-bridge`, and each run
 * tells the bridge where its thread's servers are: MYREL_MCP_BRIDGE names a file only this user can
 * read, in the run's private folder, deleted after the run. The global config holds no token and no
 * thread. Started by the person's own `agy`, the bridge has no run and offers no tools.
 */
export const BRIDGE_VAR = "MYREL_MCP_BRIDGE";

/** What one run's bridge forwards to: Myrel's server first (its tools keep their names), then the connectors. */
export type BridgeRun = { token: string; servers: AgentServer[] };

/** Antigravity's global MCP config and settings (permission rules). */
export function agyPaths(home = homedir()) {
  return {
    mcp: join(home, ".gemini", "config", "mcp_config.json"),
    settings: join(home, ".gemini", "antigravity-cli", "settings.json"),
  };
}

/** The command that starts this runner again, as a source script or as the desktop app's compiled binary. */
export function selfCommand(): { command: string; args: string[] } {
  const script = process.argv[1];
  const compiled = !script || /\$bunfs|~BUN/.test(script);
  return { command: process.execPath, args: compiled ? [] : [script] };
}

/**
 * Puts the bridge in Antigravity's global MCP config and lets its tools run without asking. Everything
 * else in both files stays. Throws when a file cannot be read as JSON, rather than overwrite it.
 */
export async function ensureBridge(name: string, home = homedir()): Promise<void> {
  const paths = agyPaths(home);
  const self = selfCommand();
  const entry = { command: self.command, args: [...self.args, "mcp-bridge"] };
  await updateJson(paths.mcp, (config) => {
    const servers = (isObject(config.mcpServers) ? config.mcpServers : {}) as Record<string, unknown>;
    if (JSON.stringify(servers[name]) === JSON.stringify(entry)) return false;
    config.mcpServers = { ...servers, [name]: entry };
    return true;
  });
  const rule = `mcp(${name}/*)`;
  await updateJson(paths.settings, (settings) => {
    const permissions = (isObject(settings.permissions) ? settings.permissions : {}) as Record<string, unknown>;
    const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
    if (allow.includes(rule)) return false;
    settings.permissions = { ...permissions, allow: [...allow, rule] };
    return true;
  });
}

async function updateJson(path: string, change: (value: Record<string, unknown>) => boolean): Promise<void> {
  const raw = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw err;
  });
  let value: unknown = {};
  if (raw.trim()) {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`Could not read ${path} as JSON, so Myrel's tools were not added to Antigravity CLI. Fix the file and try again.`);
    }
  }
  if (!isObject(value)) throw new Error(`${path} is not a JSON object, so Myrel's tools were not added to Antigravity CLI.`);
  if (!change(value)) return;
  await mkdir(dirname(path), { recursive: true });
  // Written next to it and renamed, so agy never reads half a file.
  const temp = `${path}.myrel-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type Message = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: unknown };
type Tool = { name: string; [key: string]: unknown };

/** One server the bridge forwards to. */
interface Upstream {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
}

class RpcError extends Error {
  constructor(readonly error: unknown) {
    super(typeof (error as { message?: unknown })?.message === "string" ? (error as { message: string }).message : "MCP error");
  }
}

/** A remote server over Streamable HTTP: one POST per message, the answer as JSON or as an SSE stream. */
class HttpUpstream implements Upstream {
  private session?: string;
  private version?: string;
  private next = 1;
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.next++;
    const res = await this.post({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) });
    const answer = await this.answer(res, id);
    if (method === "initialize") this.version = (answer.result as { protocolVersion?: string } | undefined)?.protocolVersion;
    if (answer.error) throw new RpcError(answer.error);
    return answer.result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const res = await this.post({ jsonrpc: "2.0", method, ...(params !== undefined && { params }) });
    await res.body?.cancel();
  }

  close() {}

  private async post(message: Message): Promise<Response> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.token}`,
        ...(this.session && { "mcp-session-id": this.session }),
        ...(this.version && { "mcp-protocol-version": this.version }),
      },
      body: JSON.stringify(message),
    });
    this.session = res.headers.get("mcp-session-id") ?? this.session;
    if (!res.ok && res.status !== 202) {
      await res.body?.cancel();
      throw new Error(`${this.url} answered ${res.status}`);
    }
    return res;
  }

  /** The answer to `id`, from a JSON body or the first matching event of an SSE stream. */
  private async answer(res: Response, id: number): Promise<Message> {
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return (await res.json()) as Message;
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        let end: number;
        while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
          const data = event
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const message = JSON.parse(data) as Message;
          if (message.id === id) return message;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    throw new Error(`${this.url} closed the stream without an answer`);
  }
}

/** A command on this computer, speaking MCP as one JSON message per line. */
class StdioUpstream implements Upstream {
  private readonly child: ChildProcess;
  private readonly waiting = new Map<number, (m: Message) => void>();
  private next = 1;
  constructor(command: string, args: string[], env: Record<string, string>) {
    this.child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" });
    this.child.on("error", () => this.fail(`could not start ${command}`));
    this.child.on("exit", () => this.fail(`${command} exited`));
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      try {
        const message = JSON.parse(line) as Message;
        if (typeof message.id === "number" && !message.method) this.waiting.get(message.id)?.(message);
      } catch {}
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (m) => {
        this.waiting.delete(id);
        if (m.error) reject(new RpcError(m.error));
        else resolve(m.result);
      });
      this.write({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", method, ...(params !== undefined && { params }) });
  }

  close() {
    this.child.kill();
  }

  private write(message: Message) {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private fail(reason: string) {
    for (const [id, done] of this.waiting) done({ jsonrpc: "2.0", id, error: { code: -32000, message: reason } });
  }
}

/** Tools of a connector carry its name: `<connector>__<tool>`. Myrel's own keep theirs. */
const SEPARATOR = "__";

/**
 * Runs the bridge on stdin and stdout until agy closes it. Exported for tests, which pass their own
 * streams and run.
 */
export async function runBridge(opts: {
  input: NodeJS.ReadableStream;
  write: (line: string) => void;
  run: BridgeRun | null;
  version: string;
}): Promise<void> {
  const { run, write } = opts;
  const upstreams = new Map<string, Upstream>();
  for (const s of run?.servers ?? []) {
    upstreams.set(s.name, s.transport === "http" ? new HttpUpstream(s.url, run!.token) : new StdioUpstream(s.command, s.args, s.env));
  }
  const first = run?.servers[0]?.name;
  const owner = new Map<string, { server: string; tool: string }>();
  let ready: Promise<string[]> | undefined;
  let listed: Promise<Tool[]> | undefined;

  /** Starts every server once; one that fails is left out, so the others still work. */
  const start = (params: unknown) =>
    (ready ??= Promise.all(
      [...upstreams].map(async ([name, up]) => {
        try {
          await up.request("initialize", params);
          await up.notify("notifications/initialized");
          return name;
        } catch (err) {
          process.stderr.write(`myrel-runner mcp-bridge: ${name}: ${(err as Error).message}\n`);
          return null;
        }
      }),
    ).then((names) => names.filter((n): n is string => n !== null)));

  const listTools = async (): Promise<Tool[]> => {
    const names = await (ready ?? start(defaultInit(opts.version)));
    const lists = await Promise.all(
      names.map(async (name) => {
        const tools: Tool[] = [];
        let cursor: string | undefined;
        try {
          do {
            const page = (await upstreams.get(name)!.request("tools/list", cursor ? { cursor } : {})) as { tools?: Tool[]; nextCursor?: string };
            tools.push(...(page.tools ?? []));
            cursor = page.nextCursor;
          } while (cursor);
        } catch (err) {
          process.stderr.write(`myrel-runner mcp-bridge: ${name}: ${(err as Error).message}\n`);
        }
        return tools.map((t) => {
          const shown = name === first ? t.name : `${name}${SEPARATOR}${t.name}`;
          owner.set(shown, { server: name, tool: t.name });
          return { ...t, name: shown };
        });
      }),
    );
    return lists.flat();
  };

  const handle = async (m: Message): Promise<unknown> => {
    switch (m.method) {
      case "initialize": {
        const params = (m.params ?? {}) as { protocolVersion?: string };
        void start({ ...defaultInit(opts.version), ...(params.protocolVersion && { protocolVersion: params.protocolVersion }) });
        return {
          protocolVersion: params.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "myrel", version: opts.version },
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: await (listed = listTools()) };
      case "tools/call": {
        const params = (m.params ?? {}) as { name?: string };
        // Calls run side by side, so the first list is shared.
        await (listed ??= listTools());
        const target = params.name ? owner.get(params.name) : undefined;
        if (!target) throw new RpcError({ code: -32602, message: `Unknown tool: ${params.name}` });
        return upstreams.get(target.server)!.request("tools/call", { ...params, name: target.tool });
      }
      default:
        throw new RpcError({ code: -32601, message: `Method not found: ${m.method}` });
    }
  };

  const lines = createInterface({ input: opts.input });
  const pending: Promise<void>[] = [];
  for await (const line of lines) {
    let m: Message;
    try {
      m = JSON.parse(line) as Message;
    } catch {
      continue;
    }
    // Notifications from agy need no answer, and the servers keep their own state.
    if (m.id === undefined || m.id === null || !m.method) continue;
    const id = m.id;
    pending.push(
      handle(m).then(
        (result) => write(JSON.stringify({ jsonrpc: "2.0", id, result })),
        (err) => {
          const error = err instanceof RpcError ? err.error : { code: -32603, message: (err as Error).message };
          write(JSON.stringify({ jsonrpc: "2.0", id, error }));
        },
      ),
    );
  }
  await Promise.all(pending);
  for (const up of upstreams.values()) up.close();
}

function defaultInit(version: string) {
  return { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "myrel-runner", version } };
}

/** The run named in MYREL_MCP_BRIDGE, or null outside a run from Myrel. */
export async function readBridgeRun(): Promise<BridgeRun | null> {
  const path = process.env[BRIDGE_VAR];
  if (!path) return null;
  const raw = await readFile(path, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BridgeRun;
  } catch {
    return null;
  }
}
