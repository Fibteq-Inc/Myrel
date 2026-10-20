import {
  HARNESSES,
  LineSplitter,
  parseLine,
  type RunnerEvent,
  SETUP_NOTE,
  STOP_HARNESS_SCRIPT,
  TaskSpec,
  taskEnv,
  taskScript,
} from "@myrel/runner-core";
import { getAgentByName } from "agents";
import { DurableObject } from "cloudflare:workers";
import { BASE_IMAGE, SANDBOX_HOME, SANDBOX_USER, SETUP_SCRIPT, SETUP_VERSION } from "./setup";

export type SandboxRun = { threadId: string; spec: TaskSpec; secrets: Record<string, string> };

/** The Sandbox instance that builds and keeps the base snapshot every thread starts from. */
const BASE = "base";
/** Keeps a started container up: work arrives through exec. */
const ENTRYPOINT = ["sleep", "infinity"];
/** How long an idle container stays up before it sleeps. A thread's next task reuses a warm one. */
const IDLE_MS = 10 * 60_000;
/** Events are sent to the thread in batches, at most this often. */
const FLUSH_MS = 750;
const MAX_BATCH = 200;
/** Preparing the tools takes a few minutes; past this something is stuck, so it fails and can be retried. */
const BUILD_TIMEOUT_MS = 12 * 60_000;
/** While a thread waits for the tools, it hears that the sandbox is still working this often. */
const HEARTBEAT_MS = 30_000;
/** After preparing the tools failed, the scheduled warm-up leaves it alone this long. */
const PREWARM_BACKOFF_MS = 60 * 60_000;

type BaseSnapshot = { version: string; snapshot: ContainerSnapshot };

/**
 * One per thread (named by thread id): the thread's Linux container. It runs
 * one task at a time with the shared task script from @myrel/runner-core and
 * streams the events back to the ThreadAgent through `taskEvents`.
 *
 * No image is built on deploy. The instance named "base" starts Cloudflare's
 * managed Debian image once, installs the tools (setup.ts) and snapshots it;
 * thread containers start from that snapshot.
 */
export class Sandbox extends DurableObject<Env> {
  private current: { taskId: string; abort: AbortController } | null = null;
  private building: Promise<BaseSnapshot> | null = null;

  /** Starts a task and returns once it is running. Its events go to the thread. */
  async run(input: SandboxRun): Promise<void> {
    if (this.current) throw new Error("This thread's sandbox is already running a task.");
    const spec = TaskSpec.parse(input.spec);
    const abort = new AbortController();
    this.current = { taskId: spec.taskId, abort };
    this.ctx.waitUntil(this.execute(input.threadId, spec, input.secrets, abort.signal));
  }

  async cancel(taskId: string): Promise<void> {
    if (this.current?.taskId === taskId) this.current.abort.abort(new Error("Cancelled"));
  }

  /**
   * Ends a task's harness as finished, when its turn is done but the harness has not exited by
   * itself. The task's script goes on to save the work. False when nothing was running.
   */
  async finish(taskId: string): Promise<boolean> {
    const container = this.ctx.container;
    if (this.current?.taskId !== taskId || !container?.running) return false;
    const proc = await container.exec(["bash", "-c", STOP_HARNESS_SCRIPT], { user: SANDBOX_USER });
    return (await proc.exitCode) === 0;
  }

  /** For project deletion: stops the task and the container and erases this sandbox's storage. */
  async wipe(): Promise<void> {
    this.current?.abort.abort(new Error("The project was deleted"));
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    await this.ctx.storage.deleteAll();
  }

  private async execute(threadId: string, spec: TaskSpec, secrets: Record<string, string>, signal: AbortSignal) {
    const thread = await getAgentByName(this.env.THREAD_AGENT, threadId);
    const harness = HARNESSES[spec.harness];
    let pending: RunnerEvent[] = [];
    let flushing: Promise<void> = Promise.resolve();
    const flush = () => {
      const batch = pending;
      pending = [];
      if (batch.length) flushing = flushing.then(() => thread.taskEvents(spec.taskId, batch));
      return flushing;
    };
    const timer = setInterval(flush, FLUSH_MS);
    const push = (...events: RunnerEvent[]) => {
      pending.push(...events);
      if (pending.length >= MAX_BATCH) void flush();
    };

    let done: RunnerEvent;
    try {
      const opening = Date.now();
      push(
        { type: "phase", phase: "prepare", state: "started" },
        { type: "log", stream: "system", text: `Starting ${harness.label} in the sandbox…` },
      );
      const container = await this.container(
        (text, ms) => push({ type: "log", stream: "system", text, ...(ms !== undefined && { ms }) }),
        () => push({ type: "phase", phase: "prepare", state: "started", detail: SETUP_NOTE }),
        signal,
      );
      push({ type: "log", stream: "system", text: "Sandbox ready", ms: Date.now() - opening });
      const timeout = AbortSignal.timeout(spec.timeoutSec * 1000);
      const proc = await execWhenReady(container, ["bash", "-c", taskScript()], {
        env: { HOME: SANDBOX_HOME, CI: "1", GIT_TERMINAL_PROMPT: "0", ...taskEnv(spec, harness), ...secrets },
        user: SANDBOX_USER,
        stdout: "pipe",
        stderr: "combined",
        signal: AbortSignal.any([signal, timeout]),
      });
      // How long the harness takes to start: from its phase starting to the first thing it says.
      // A harness that reports usage per model step (OpenCode) also shows how long each step took,
      // so a slow model is told apart from a stuck sandbox.
      let agentStarted = Date.now();
      let stepStarted = agentStarted;
      let steps = 0;
      let answered = false;
      const take = (line: string) => {
        for (const e of parseLine(harness, line)) {
          if (e.type === "phase" && e.phase === "agent" && e.state === "started") agentStarted = stepStarted = Date.now();
          if (!answered && (e.type === "text" || e.type === "tool" || e.type === "todos" || e.type === "usage")) {
            answered = true;
            push({ type: "log", stream: "system", text: `${harness.label} started`, ms: Date.now() - agentStarted });
          }
          push(e);
          if (e.type === "usage") {
            const now = Date.now();
            const tokens = e.inputTokens + e.outputTokens;
            push({ type: "log", stream: "system", text: `Model step ${++steps} (${tokens.toLocaleString("en")} tokens)`, ms: now - stepStarted });
            stepStarted = now;
          }
        }
      };
      const lines = new LineSplitter();
      const reader = proc.stdout!.getReader();
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        for (const line of lines.push(value as Uint8Array)) take(line);
      }
      for (const line of lines.end()) take(line);
      const exitCode = await proc.exitCode;
      done = signal.aborted
        ? { type: "done", ok: false, exitCode, error: "Cancelled." }
        : timeout.aborted
          ? { type: "done", ok: false, exitCode, error: `Timed out after ${spec.timeoutSec} seconds.` }
          : { type: "done", ok: exitCode === 0, exitCode, ...(exitCode === 0 ? {} : { error: `Exited with code ${exitCode}.` }) };
    } catch (err) {
      const message = signal.aborted ? "Cancelled." : err instanceof Error ? err.message : String(err);
      done = { type: "done", ok: false, error: message.slice(0, 4000) };
    } finally {
      clearInterval(timer);
      this.current = null;
    }
    push(done);
    try {
      await flush();
    } catch (err) {
      console.error("could not deliver task events", err);
    }
  }

  /** The running container, started from the base snapshot on first use. */
  private async container(
    log: (text: string, ms?: number) => void,
    settingUp: () => void,
    signal: AbortSignal,
  ): Promise<Container> {
    const container = this.ctx.container;
    if (!container) throw new Error("The sandbox container is not configured on this server.");
    if (container.running) return container;
    const base = this.env.SANDBOX.getByName(BASE);
    let id = (await base.baseSnapshot(false))?.id;
    if (!id) {
      settingUp();
      log("Preparing the sandbox tools. This happens once and takes a few minutes…");
      id = await this.waitForBase(() => base.baseSnapshot(true), log, signal);
    }
    try {
      await abortable(this.startFrom(container, id), signal);
    } catch (err) {
      if (signal.aborted) throw err;
      // Snapshots expire after 30 unused days: rebuild once.
      console.warn("sandbox: starting from the base snapshot failed, rebuilding it", err);
      settingUp();
      log("Preparing the sandbox tools again. This takes a few minutes…");
      const stale = id;
      await abortable(this.startFrom(container, await this.waitForBase(() => base.baseSnapshot(true, stale), log, signal)), signal);
    }
    return container;
  }

  /**
   * Waits for the base snapshot, telling the thread every half minute how long it has been, so a
   * slow first start never looks frozen. Stop works while waiting; the build itself carries on for
   * the next thread.
   */
  private async waitForBase(
    build: () => Promise<ContainerSnapshot | null>,
    log: (text: string, ms?: number) => void,
    signal: AbortSignal,
  ): Promise<string> {
    const started = Date.now();
    const beat = setInterval(() => log(`Still preparing the sandbox tools (${clock(Date.now() - started)})…`), HEARTBEAT_MS);
    try {
      const snapshot = await abortable(build(), signal);
      log("Prepared the sandbox tools", Date.now() - started);
      return snapshot!.id;
    } finally {
      clearInterval(beat);
    }
  }

  private async startFrom(container: Container, snapshotId: string) {
    if (container.running) await container.destroy();
    container.start({
      containerSnapshot: { id: snapshotId },
      entrypoint: ENTRYPOINT,
      // Coding agents need the package registries, git hosts and the model API.
      enableInternet: true,
      instance: (this.env.SANDBOX_INSTANCE_TYPE || "standard-1") as ContainerStartupOptions["instance"],
    });
    await container.setInactivityTimeout(IDLE_MS);
    const probe = await execWhenReady(container, ["true"], {});
    if ((await probe.exitCode) !== 0) throw new Error("The sandbox did not start.");
  }

  /**
   * On the "base" instance: the snapshot thread containers start from. With
   * `build`, makes it when it is missing, outdated or is `stale` (an id that
   * failed to start); otherwise returns null when there is none to use.
   */
  async baseSnapshot(build: boolean, stale?: string): Promise<ContainerSnapshot | null> {
    const saved = await this.ctx.storage.get<BaseSnapshot>("base");
    if (saved && saved.version === SETUP_VERSION && saved.snapshot.id !== stale) return saved.snapshot;
    if (!build) return null;
    this.building ??= this.buildBase().finally(() => {
      this.building = null;
    });
    return (await this.building).snapshot;
  }

  /**
   * On the "base" instance, from the scheduled warm-up: starts preparing the tools when a deploy
   * changed them, so the first thread after it does not wait. Runs in an alarm, which keeps the
   * instance alive for the whole build.
   */
  async prewarm(): Promise<void> {
    const saved = await this.ctx.storage.get<BaseSnapshot>("base");
    if (saved?.version === SETUP_VERSION || this.building) return;
    const failedAt = (await this.ctx.storage.get<number>("base_failed_at")) ?? 0;
    if (Date.now() - failedAt < PREWARM_BACKOFF_MS) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(): Promise<void> {
    try {
      await this.baseSnapshot(true);
    } catch (err) {
      console.error("sandbox: preparing the base snapshot ahead of time failed", err);
    }
  }

  private async buildBase(): Promise<BaseSnapshot> {
    const container = this.ctx.container;
    if (!container) throw new Error("The sandbox container is not configured on this server.");
    if (container.running) await container.destroy();
    const started = Date.now();
    const timeout = AbortSignal.timeout(BUILD_TIMEOUT_MS);
    container.start({ image: BASE_IMAGE, entrypoint: ENTRYPOINT, enableInternet: true, instance: "standard-1" });
    try {
      const proc = await execWhenReady(container, ["bash", "-c", SETUP_SCRIPT], { stdout: "pipe", stderr: "combined", signal: timeout });
      const output = await abortable(new Response(proc.stdout).text(), timeout);
      const code = await abortable(proc.exitCode, timeout);
      if (code !== 0) throw new Error(`Preparing the sandbox failed (exit ${code}): ${output.slice(-2000)}`);
      const snapshot = await abortable(container.snapshotContainer({ name: `myrel-base-${SETUP_VERSION}` }), timeout);
      const base = { version: SETUP_VERSION, snapshot };
      await this.ctx.storage.put("base", base);
      await this.ctx.storage.delete("base_failed_at");
      const steps = output.split("\n").filter((l) => l.startsWith("+ ["));
      console.log(`sandbox: prepared the base snapshot ${SETUP_VERSION} in ${clock(Date.now() - started)}\n${steps.join("\n").slice(0, 4000)}`);
      return base;
    } catch (err) {
      await this.ctx.storage.put("base_failed_at", Date.now());
      if (timeout.aborted) {
        throw new Error(`Preparing the sandbox tools did not finish in ${BUILD_TIMEOUT_MS / 60_000} minutes. Send the message again to retry.`);
      }
      throw err;
    } finally {
      await container.destroy().catch(() => {});
    }
  }
}

/** From the cron trigger: has the base instance prepare the tools when they are missing or outdated. */
export async function prewarmSandbox(env: Env): Promise<void> {
  if (env.SANDBOX) await env.SANDBOX.getByName(BASE).prewarm();
}

/** Settles like `promise`, or rejects as soon as `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** 95_000 → "1m 35s", for log lines. */
function clock(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** A container that was just started may refuse exec for a moment; retry briefly. */
async function execWhenReady(container: Container, cmd: string[], options: ContainerExecOptions): Promise<ExecProcess> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await container.exec(cmd, options);
    } catch (err) {
      if (attempt >= 20 || options.signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
