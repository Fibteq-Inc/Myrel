import { watchFile, unwatchFile } from "node:fs";
import { hostname, platform } from "node:os";
import {
  type CliId,
  type CliLimits,
  PairRunnerResult,
  RUNNER_PROTOCOL_VERSION,
  type RunnerToServer,
  ServerToRunner,
} from "@myrel/protocol";
import { detectClis } from "./clis";
import { configPath, loadConfig, type RunnerConfig, saveConfig, SessionStore, shareFolder, unshareFolder } from "./config";
import { readProjectFile } from "./files";
import { listDirs, shareableFolder } from "./folders";
import { loadLimits, readCodexLimits, saveLimits } from "./limits";
import { saveInterrupted, takeInterrupted, writeRunning } from "./restart";
import { applySettings, settingsOf, updateMode } from "./self-update";
import { relaunchService } from "./service";
import { TaskRunner } from "./tasks";
import { CONFIRM_MS, Updater } from "./updater";
import { pruneWorktrees } from "./worktrees";

export const RUNNER_VERSION = "0.13.0";

/** How often a background runner with auto-update on looks for a newer version. */
const AUTO_UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;

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

/** How long a task's result is sent again after each reconnect. */
const RESEND_RESULTS_MS = 15 * 60 * 1000;

/** Why the runner stopped. "restart": to run another version; the caller exits with RESTART_EXIT_CODE. */
export type StopReason = "stopped" | "revoked" | "replaced" | "refused" | "restart";

export type RunnerHandle = { stop(): void; done: Promise<StopReason> };

/** A failed exit, so launchd and systemd start the background runner again (now the new copy). */
export const RESTART_EXIT_CODE = 75;

/** Machine-readable state changes, for apps that embed or supervise the runner. */
export type RunnerStatus =
  | { state: "connecting" }
  | { state: "online"; name: string }
  | { state: "offline"; reason: string; retryInMs: number }
  | { state: "stopped"; reason: StopReason }
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
  // The last limits each CLI reported; hello carries them with the CLI's version.
  const limits = await loadLimits();
  const setLimits = (cli: CliId, next: CliLimits | undefined) => {
    const prev = limits[cli];
    if (!next || (prev && prev.at >= next.at)) return;
    limits[cli] = next;
    void saveLimits(limits).catch(() => {});
    if (JSON.stringify({ ...prev, at: "" }) !== JSON.stringify({ ...next, at: "" })) hello();
  };
  // Codex writes its limits whenever the person uses it, in Myrel or not; looked at now and then.
  const readCodex = () => {
    if (clis.some((c) => c.id === "codex")) void readCodexLimits().then((l) => setLimits("codex", l), () => {});
  };
  const tasks = new TaskRunner({ config: () => config, sessions: new SessionStore(), log, onLimits: setLimits, onChange: writeRunning });
  // What the previous runner was doing when it stopped (an update, a restart): the server continues it.
  const interrupted = takeInterrupted();
  if (interrupted.length) log(`${interrupted.length} task(s) stopped when the runner restarted; Myrel continues them.`);
  writeRunning([]);
  let stopReason: StopReason = "stopped";
  let socket: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let finish!: (reason: StopReason) => void;
  const done = new Promise<StopReason>((r) => (finish = r));
  const updates = updateMode();
  const updater = new Updater({
    version: RUNNER_VERSION,
    running: () => tasks.runningIds(),
    report: (update) => send({ type: "update.status", update }),
    log,
    restart: () => {
      // Windows starts the new copy itself; launchd and systemd do once this process exits.
      void relaunchService()
        .catch(() => {})
        .finally(() => {
          stopReason = "restart";
          stop();
        });
    },
  });
  // A new version that has not connected yet goes back to the previous one if it never does.
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  if (await updater.init()) {
    confirmTimer = setTimeout(() => {
      void checkPairing(config).then((pairing) => {
        // Offline or unpaired is not this version's fault: the previous one would not connect either.
        if (pairing === "ok" && updater.confirming) void updater.rollback("it did not connect within 2 minutes");
      });
    }, CONFIRM_MS);
    confirmTimer.unref?.();
  }

  // Results of recent tasks, sent again first thing after reconnecting: a result sent just as the
  // connection dropped (a new version of Myrel being deployed) may never have arrived. The server
  // ignores results of tasks it already finished.
  const results = new Map<string, { frame: RunnerToServer; at: number }>();
  const send = (frame: RunnerToServer) => {
    if (frame.type === "task.done") {
      status({ state: "task", taskId: frame.taskId, event: "done", ok: frame.ok });
      results.set(frame.taskId, { frame, at: Date.now() });
    }
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };
  const resendResults = () => {
    for (const [taskId, { frame, at }] of results) {
      if (Date.now() - at > RESEND_RESULTS_MS) results.delete(taskId);
      else send(frame);
    }
  };
  const hello = () =>
    send({
      type: "hello",
      protocol: RUNNER_PROTOCOL_VERSION,
      version: RUNNER_VERSION,
      hostname: hostname(),
      platform: platform(),
      folders: config.folders,
      clis: clis.map((c) => (limits[c.id] ? { ...c, limits: limits[c.id] } : c)),
      features: [
        "folders",
        "cancel",
        "agent",
        "agent-clis",
        "connectors",
        "skills",
        "project-folders",
        "files",
        "settings",
        ...(updates === "service" ? (["update"] as const) : []),
      ],
      settings: settingsOf(config),
      updates,
      ...(updater.state() && { update: updater.state() }),
      running: tasks.runningIds(),
      interrupted,
    });
  tasks.setSender(send);

  // `myrel-runner share` in another terminal shows up in the web app without a restart.
  const onConfigChange = async () => {
    config = await loadConfig().catch(() => config);
    hello();
  };
  watchFile(configPath(), { interval: 2000 }, onConfigChange);

  const ping = setInterval(() => send({ type: "ping" }), 25_000);
  readCodex();
  const codexLimits = setInterval(readCodex, 10 * 60 * 1000);
  codexLimits.unref?.();
  // Removes the worktrees of threads whose work is merged (see pruneWorktrees).
  const prune = () =>
    void pruneWorktrees((w) => tasks.inUse(w))
      .then((removed) => removed.forEach((w) => log(`Removed the finished worktree ${w.path} (${w.branch})`)))
      .catch(() => {});
  prune();
  const pruning = setInterval(prune, 6 * 60 * 60 * 1000);
  pruning.unref?.();
  // Auto-update (background runner only): a while after starting, then every few hours.
  const autoUpdate = () => {
    if (updates === "service" && config.autoUpdate) void updater.checkNewest().catch(() => {});
  };
  const firstCheck = setTimeout(autoUpdate, 10 * 60 * 1000);
  firstCheck.unref?.();
  const autoUpdating = setInterval(autoUpdate, AUTO_UPDATE_EVERY_MS);
  autoUpdating.unref?.();
  const stop = () => {
    stopped = true;
    clearInterval(ping);
    clearInterval(pruning);
    clearInterval(codexLimits);
    clearInterval(autoUpdating);
    clearTimeout(firstCheck);
    clearTimeout(confirmTimer);
    unwatchFile(configPath(), onConfigChange);
    saveInterrupted(tasks.stopAll());
    socket?.close(1000);
    status({ state: "stopped", reason: stopReason });
    finish(stopReason);
  };

  // Folder requests from the web app: browse folders, share or stop sharing one.
  const answer = async (frame: Extract<ServerToRunner, { requestId: string }>) => {
    const { requestId } = frame;
    if (frame.type === "dirs.list") return send({ type: "dirs", requestId, ...(await listDirs(frame.path)) });
    if (frame.type === "file.read") return send({ type: "file", requestId, ...(await readProjectFile(config, frame)) });
    if (frame.type === "runner.update") {
      if (updates !== "service") {
        throw new Error(
          updates === "app"
            ? "This runner came with the Myrel desktop app; it updates with the app."
            : "This runner was started in a terminal, so it cannot restart itself. Start it again with `npx myrel-runner@latest start`.",
        );
      }
      log(`Updating to myrel-runner ${frame.version} (from Myrel)${frame.now ? "" : " once the running tasks finish"}`);
      return send({ type: "update.accepted", requestId, update: updater.request(frame.version, frame.now) });
    }
    config = await loadConfig();
    if (frame.type === "settings.set") {
      applySettings(config, frame.settings);
      await saveConfig(config);
      log(`Settings changed from Myrel: ${Object.entries(frame.settings).map(([k, v]) => `${k} ${v}`).join(", ")}`);
      return send({ type: "settings", requestId, settings: settingsOf(config) });
    }
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
      resendResults();
      hello();
    };
    ws.onmessage = (e) => {
      const parsed = ServerToRunner.safeParse(JSON.parse(String(e.data)));
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.type === "welcome") {
        log(`● Connected to ${config.server} as "${frame.name}"`);
        status({ state: "online", name: frame.name });
        void updater.confirmed();
      }
      if (frame.type === "task.start") {
        status({ state: "task", taskId: frame.taskId, event: "started" });
        void tasks.start(frame);
      }
      if (frame.type === "task.cancel") tasks.cancel(frame.taskId);
      if ("requestId" in frame) {
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
        if (updater.confirming) {
          await updater.rollback(`the server refused it: ${e.reason}`);
          if (stopped) return;
        }
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
