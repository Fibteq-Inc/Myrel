import { watchFile, unwatchFile } from "node:fs";
import { hostname, platform } from "node:os";
import {
  PairRunnerResult,
  RUNNER_PROTOCOL_VERSION,
  type RunnerToServer,
  ServerToRunner,
} from "@myrel/protocol";
import { detectClis } from "./clis";
import { configPath, loadConfig, type RunnerConfig, saveConfig, SessionStore, shareFolder, unshareFolder } from "./config";
import { listDirs, shareableFolder } from "./folders";
import { TaskRunner } from "./tasks";
import { pruneWorktrees } from "./worktrees";

export const RUNNER_VERSION = "0.6.0";

/** Trades a pairing code from the web app for a runner token, and saves it. */
export async function pair(input: { server: string; code: string; name?: string }): Promise<RunnerConfig> {
  const server = input.server.replace(/\/+$/, "");
  const res = await fetch(`${server}/api/runner/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: input.code, name: input.name || hostname(), hostname: hostname(), platform: platform() }),
  });
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) throw new Error(body?.message ?? `Pairing failed (${res.status})`);
  const paired = PairRunnerResult.parse(body);
  const config = await loadConfig();
  Object.assign(config, { server, runnerId: paired.runner.id, token: paired.token });
  await saveConfig(config);
  return config;
}

/**
 * Asks the server whether this computer's pairing is still valid. "unknown"
 * when the server cannot be reached or is too old to say.
 */
export async function checkPairing(config: Pick<RunnerConfig, "server" | "token">): Promise<"ok" | "invalid" | "unknown"> {
  if (!config.server || !config.token) return "invalid";
  try {
    const res = await fetch(`${config.server}/api/runner/me`, {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return "ok";
    return res.status === 401 ? "invalid" : "unknown";
  } catch {
    return "unknown";
  }
}

const UNPAIRED =
  "This computer is not paired with Myrel any more (it was removed, or paired again elsewhere). Get a new code in Myrel > Devices and run `myrel-runner pair <code> --server <url>`.";

export type RunnerHandle = { stop(): void; done: Promise<void> };

/** Machine-readable state changes, for apps that embed or supervise the runner. */
export type RunnerStatus =
  | { state: "connecting" }
  | { state: "online"; name: string }
  | { state: "offline"; reason: string; retryInMs: number }
  | { state: "stopped"; reason: "stopped" | "revoked" | "replaced" | "refused" }
  | { state: "task"; taskId: string; event: "started" | "done"; ok?: boolean };

export type StartOptions = {
  log?: (line: string) => void;
  onStatus?: (status: RunnerStatus) => void;
  /** Called when the server says this runner no longer exists. */
  onRevoked?: () => void;
};

/**
 * Keeps an outbound WebSocket to the server open (reconnecting with backoff),
 * announces the shared folders and installed CLIs, and runs tasks. Embeddable:
 * the desktop app can call this instead of spawning the CLI.
 */
export async function startRunner(opts: StartOptions = {}): Promise<RunnerHandle> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const status = opts.onStatus ?? (() => {});
  let config = await loadConfig();
  if (!config.server || !config.token) throw new Error("This computer is not paired yet. Run `myrel-runner pair <code> --server <url>` first.");

  const clis = await detectClis();
  const tasks = new TaskRunner({ config: () => config, sessions: new SessionStore(), log });
  let stopReason: Extract<RunnerStatus, { state: "stopped" }>["reason"] = "stopped";
  let socket: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));

  // Results of tasks that finished while offline, sent first thing after reconnecting.
  const pending: RunnerToServer[] = [];
  const send = (frame: RunnerToServer) => {
    if (frame.type === "task.done") status({ state: "task", taskId: frame.taskId, event: "done", ok: frame.ok });
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    else if (frame.type === "task.done") pending.push(frame);
  };
  const hello = () =>
    send({
      type: "hello",
      protocol: RUNNER_PROTOCOL_VERSION,
      version: RUNNER_VERSION,
      hostname: hostname(),
      platform: platform(),
      folders: config.folders,
      clis,
      features: ["folders", "cancel", "agent", "agent-clis"],
      running: tasks.runningIds(),
    });
  tasks.setSender(send);

  // `myrel-runner share` in another terminal shows up in the web app without a restart.
  const onConfigChange = async () => {
    config = await loadConfig().catch(() => config);
    hello();
  };
  watchFile(configPath(), { interval: 2000 }, onConfigChange);

  const ping = setInterval(() => send({ type: "ping" }), 25_000);
  // Removes the worktrees of threads whose work is merged (see pruneWorktrees).
  const prune = () =>
    void pruneWorktrees((w) => tasks.inUse(w))
      .then((removed) => removed.forEach((w) => log(`Removed the finished worktree ${w.path} (${w.branch})`)))
      .catch(() => {});
  prune();
  const pruning = setInterval(prune, 6 * 60 * 60 * 1000);
  pruning.unref?.();
  const stop = () => {
    stopped = true;
    clearInterval(ping);
    clearInterval(pruning);
    unwatchFile(configPath(), onConfigChange);
    tasks.stopAll();
    socket?.close(1000);
    status({ state: "stopped", reason: stopReason });
    finish();
  };

  // Folder requests from the web app: browse folders, share or stop sharing one.
  const answer = async (frame: Extract<ServerToRunner, { requestId: string }>) => {
    const { requestId } = frame;
    if (frame.type === "dirs.list") return send({ type: "dirs", requestId, ...(await listDirs(frame.path)) });
    config = await loadConfig();
    if (frame.type === "folder.share") {
      const path = await shareableFolder(frame.path);
      if (shareFolder(config, path)) log(`Shared ${path} (from Myrel)`);
    } else if (unshareFolder(config, frame.path)) {
      log(`Stopped sharing ${frame.path} (from Myrel)`);
    }
    await saveConfig(config);
    send({ type: "folders", requestId, folders: config.folders });
  };

  const connect = () => {
    if (stopped) return;
    const url = `${config.server!.replace(/^http/, "ws")}/api/runner/connect`;
    status({ state: "connecting" });
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${config.token}` } } as never);
    socket = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      attempt = 0;
      // Before hello: the server fails any task that hello does not list as running.
      for (const frame of pending.splice(0)) send(frame);
      hello();
    };
    ws.onmessage = (e) => {
      const parsed = ServerToRunner.safeParse(JSON.parse(String(e.data)));
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.type === "welcome") {
        log(`● Connected to ${config.server} as "${frame.name}"`);
        status({ state: "online", name: frame.name });
      }
      if (frame.type === "task.start") {
        status({ state: "task", taskId: frame.taskId, event: "started" });
        void tasks.start(frame);
      }
      if (frame.type === "task.cancel") tasks.cancel(frame.taskId);
      if (frame.type === "dirs.list" || frame.type === "folder.share" || frame.type === "folder.unshare") {
        void answer(frame).catch((err: unknown) =>
          send({ type: "request.failed", requestId: frame.requestId, message: errorText(err) }),
        );
      }
    };
    let down = false;
    const onDown = async (e: { code: number; reason: string }) => {
      if (down || socket !== ws || stopped) return;
      down = true;
      // A refused upgrade looks like any network error; ask whether the token is the reason.
      if (!opened && (await checkPairing(config)) === "invalid") {
        log(UNPAIRED);
        opts.onRevoked?.();
        stopReason = "revoked";
        return stop();
      }
      if (e.code === 4401) {
        log("This computer was removed from Myrel. Pair it again with `myrel-runner pair`.");
        opts.onRevoked?.();
        stopReason = "revoked";
        return stop();
      }
      if (e.code === 4000) {
        log("myrel-runner was started somewhere else with this computer's login, so this one stops.");
        stopReason = "replaced";
        return stop();
      }
      if (e.code === 4400) {
        log(`The server refused this runner: ${e.reason}`);
        stopReason = "refused";
        return stop();
      }
      // Tasks keep running while offline; their results are sent after reconnecting.
      const delay = Math.min(30_000, 1000 * 2 ** attempt++);
      log(`○ Disconnected${e.reason ? ` (${e.reason})` : ""}. Reconnecting in ${Math.round(delay / 1000)}s…`);
      status({ state: "offline", reason: e.reason || `code ${e.code}`, retryInMs: delay });
      setTimeout(connect, delay);
    };
    ws.onclose = (e) => void onDown(e);
    // Some Node versions fire only "error", never "close", when the upgrade is refused (e.g. a 401).
    ws.onerror = () => {
      if (!opened) void onDown({ code: 1006, reason: "" });
    };
  };
  connect();

  log(`Sharing ${config.folders.length} folder(s); CLIs found: ${clis.map((c) => c.id).join(", ") || "none"}`);
  return { stop, done };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
