import {
  HARNESSES,
  type HarnessId,
  LineSplitter,
  parseLine,
  type RunnerEvent,
  STOP_HARNESS_SCRIPT,
  TaskSpec,
  taskEnv,
  taskScript,
} from "@myrel/runner-core";
import { getAgentByName } from "agents";
import { DurableObject } from "cloudflare:workers";
import { FOLLOW_SCRIPT, KILL_SCRIPT, MIN_SCRUBBED, PROBE_SCRIPT, SCRUB_JS, START_SCRIPT } from "./run-scripts";
import { SANDBOX_HOME, SANDBOX_USER } from "./setup";

/** principal: the person the task works for ("" for nobody in particular), see `execute`. */
export type SandboxRun = { threadId: string; spec: TaskSpec; secrets: Record<string, string>; principal?: string };

/** The image every thread's container starts from (`containers[].images.base` in wrangler.jsonc). */
const IMAGE = "base";
/** Keeps a started container up: work arrives through exec. */
const ENTRYPOINT = ["sleep", "infinity"];
/** How long an idle container stays up before it sleeps. A thread's next task reuses a warm one. */
const IDLE_MS = 10 * 60_000;
/** Events are sent to the thread in batches, at most this often. */
const FLUSH_MS = 750;
const MAX_BATCH = 200;
/** Storage key: who the running container's last task worked for. */
const PRINCIPAL_KEY = "principal";

/**
 * A task running in the container, kept in storage so the sandbox finds it again after a restart.
 * lines: how many lines of its output already reached the thread.
 */
type StoredRun = { taskId: string; threadId: string; harness: HarnessId; timeoutSec: number; deadline: number; lines: number };
const RUN_KEY = "run";

/** How many times a follow that broke off without the run ending is started again. */
const MAX_FOLLOWS = 3;

/**
 * One per thread (named by thread id): the thread's Linux container. It runs
 * one task at a time with the shared task script from @myrel/runner-core and
 * streams the events back to the ThreadAgent through `taskEvents`.
 *
 * The task runs on its own in the container (START_SCRIPT) and this object follows its output.
 * A deploy restarts this object but not the container: the thread's next check (`running`) finds
 * the run in storage and follows it again from the line it got to, so the turn goes on.
 *
 * Containers start from the image built from apps/api/sandbox/Dockerfile and
 * pinned by digest in wrangler.jsonc, with every tool already installed.
 */
export class Sandbox extends DurableObject<Env> {
  private current: { taskId: string; abort: AbortController } | null = null;
  /** The task that ran last, so it reads as running until its last events reached the thread. */
  private ended: string | null = null;
  /** A container start under way (from warm or a task), which a second caller joins rather than restarting it. */
  private starting: Promise<void> | null = null;
  /** How the last start went: until the container took its first command, and how many tries that took. */
  private lastStart: { ms: number; tries: number } | null = null;

  /** Starts a task and returns once it is running. Its events go to the thread. */
  async run(input: SandboxRun): Promise<void> {
    if (this.current) throw new Error("This thread's sandbox is already running a task.");
    const spec = TaskSpec.parse(input.spec);
    const abort = new AbortController();
    this.current = { taskId: spec.taskId, abort };
    this.ctx.waitUntil(this.execute(input.threadId, spec, input.secrets, abort.signal, input.principal ?? ""));
  }

  /** Starts the container ahead of a task, while the thread still prepares the turn, so the task finds it running. */
  async warm(): Promise<void> {
    const container = this.ctx.container;
    if (!container || container.running || this.starting || this.current) return;
    const started = Date.now();
    await this.startOnce(container)
      .then(() => console.log(`sandbox: warmed in ${clock(Date.now() - started)}`))
      .catch((err) => console.warn("sandbox: warming up failed", err));
  }

  /**
   * Stops a task. False when this sandbox is not following it: the thread then settles the task
   * itself. A run this sandbox lost track of is stopped, and so is a container left over from one.
   */
  async cancel(taskId: string): Promise<boolean> {
    if (this.current?.taskId === taskId) {
      this.current.abort.abort(new Error("Cancelled"));
      return true;
    }
    const container = this.ctx.container;
    if (!this.current && container?.running) {
      const run = await this.ctx.storage.get<StoredRun>(RUN_KEY);
      if (run?.taskId === taskId) await this.kill(container).catch(() => {});
      else await container.destroy().catch(() => {});
    }
    if ((await this.ctx.storage.get<StoredRun>(RUN_KEY))?.taskId === taskId) await this.ctx.storage.delete(RUN_KEY);
    return this.ended === taskId;
  }

  /**
   * Whether the task is still running here (or just ended and is reporting so). A run this object
   * lost track of, because a deploy restarted it, is followed again from where it got to.
   */
  async running(taskId: string): Promise<boolean> {
    if (this.current?.taskId === taskId || this.ended === taskId) return true;
    if (this.current) return false;
    const run = await this.ctx.storage.get<StoredRun>(RUN_KEY);
    const container = this.ctx.container;
    if (run?.taskId !== taskId || !container?.running) return false;
    // Taken before anything else is awaited, so a second check at the same time does not follow it twice.
    const abort = new AbortController();
    this.current = { taskId, abort };
    const alive = await container
      .exec(["bash", "-c", PROBE_SCRIPT], { user: SANDBOX_USER })
      .then(async (p) => (await p.exitCode) === 0)
      .catch(() => false);
    if (!alive) {
      this.current = null;
      await this.ctx.storage.delete(RUN_KEY);
      return false;
    }
    this.ctx.waitUntil(this.reattach(run, abort.signal));
    return true;
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

  private async execute(threadId: string, spec: TaskSpec, secrets: Record<string, string>, signal: AbortSignal, principal: string) {
    const harness = HARNESSES[spec.harness];
    const out = await this.outbox(threadId, spec.taskId);
    let done: RunnerEvent;
    try {
      const opening = Date.now();
      out.push(
        { type: "phase", phase: "prepare", state: "started" },
        { type: "log", stream: "system", text: `Starting ${harness.label} in the sandbox…` },
      );
      // Which kind of start it was, so a slow one can be told apart: a fresh container (the image
      // still has to reach the machine), one a warm-up was starting, or one already running.
      // A warm-up in flight counts as running as soon as it called start(), so ask about it first.
      // A warm container keeps what the last task left in it (its home, git config and hooks, processes).
      // A task for someone else must not run next to that with their own connectors' secrets: it
      // gets a fresh container. One started since (see startFrom) has nothing in it yet.
      const last = await this.ctx.storage.get<string>(PRINCIPAL_KEY);
      if (!this.starting && this.ctx.container?.running && last !== undefined && last !== principal) {
        await this.ctx.container.destroy();
        out.push({ type: "log", stream: "system", text: "Starting a fresh sandbox: this turn works for someone else than the last one." });
      }
      const state = this.starting ? "warming up" : this.ctx.container?.running ? "already running" : "new";
      const container = await this.container(signal);
      await this.ctx.storage.put(PRINCIPAL_KEY, principal);
      const start = state !== "already running" && this.lastStart ? `, first command after ${clock(this.lastStart.ms)} and ${this.lastStart.tries} tries` : "";
      out.push({ type: "log", stream: "system", text: `Sandbox ready (${state}${start})`, ms: Date.now() - opening });
      const run: StoredRun = { taskId: spec.taskId, threadId, harness: spec.harness, timeoutSec: spec.timeoutSec, deadline: Date.now() + spec.timeoutSec * 1000, lines: 0 };
      const started = await execWhenReady(container, ["bash", "-c", START_SCRIPT], {
        env: {
          HOME: SANDBOX_HOME,
          CI: "1",
          GIT_TERMINAL_PROMPT: "0",
          ...taskEnv(spec, harness),
          ...secrets,
          MYREL_TASK_SCRIPT: taskScript(),
          MYREL_SCRUB_JS: SCRUB_JS,
          MYREL_SCRUB_NAMES: scrubbedNames(secrets).join(","),
        },
        user: SANDBOX_USER,
        signal,
      });
      if ((await started.exitCode) !== 0) throw new Error("The task could not start in the sandbox.");
      await this.ctx.storage.put(RUN_KEY, run);
      // What the run prints is kept and shown in the thread; a token it echoes (`env`, a failed git
      // command) is not. This does not stop an agent that means to show one, only accidents.
      done = await this.follow(container, run, out, signal, secretScrubber(secrets));
    } catch (err) {
      const message = signal.aborted ? "Cancelled." : err instanceof Error ? err.message : String(err);
      done = { type: "done", ok: false, error: message.slice(0, 4000) };
    }
    await this.settle(spec.taskId, out, done);
  }

  /** Follows a run again after this object restarted, from the line it got to. */
  private async reattach(run: StoredRun, signal: AbortSignal) {
    const out = await this.outbox(run.threadId, run.taskId, run.lines);
    let done: RunnerEvent;
    try {
      const container = this.ctx.container;
      if (!container?.running) throw new Error("The sandbox stopped while working.");
      out.push({ type: "log", stream: "system", text: "Myrel was updated while this ran; picking the run up where it was." });
      done = await this.follow(container, run, out, signal, (line) => line);
    } catch (err) {
      const message = signal.aborted ? "Cancelled." : err instanceof Error ? err.message : String(err);
      done = { type: "done", ok: false, error: message.slice(0, 4000) };
    }
    await this.settle(run.taskId, out, done);
  }

  /** Reports how the run ended and forgets it. */
  private async settle(taskId: string, out: Outbox, done: RunnerEvent) {
    this.ended = taskId;
    this.current = null;
    if ((await this.ctx.storage.get<StoredRun>(RUN_KEY))?.taskId === taskId) await this.ctx.storage.delete(RUN_KEY);
    out.push(done);
    try {
      await out.close();
    } catch (err) {
      console.error("could not deliver task events", err);
    }
  }

  /**
   * Streams a run's output to the thread until it ends, and returns its `done`. Stops the run when
   * the task is cancelled or its time is up.
   */
  private async follow(container: Container, run: StoredRun, out: Outbox, signal: AbortSignal, scrub: (line: string) => string): Promise<RunnerEvent> {
    const harness = HARNESSES[run.harness];
    const timeout = AbortSignal.timeout(Math.max(0, run.deadline - Date.now()));
    const stop = AbortSignal.any([signal, timeout]);
    const killed = new Promise<void>((resolve) => {
      const onStop = () => void this.kill(container).catch(() => {}).finally(resolve);
      if (stop.aborted) onStop();
      else stop.addEventListener("abort", onStop, { once: true });
    });
    // How long the harness takes to start: from its phase starting to the first thing it says.
    // A harness that reports usage per model step (OpenCode) also shows how long each step took,
    // so a slow model is told apart from a stuck sandbox.
    let agentStarted = Date.now();
    let stepStarted = agentStarted;
    let steps = 0;
    let answered = run.lines > 0;
    const take = (line: string) => {
      for (const e of parseLine(harness, line)) {
        if (e.type === "phase" && e.phase === "agent" && e.state === "started") agentStarted = stepStarted = Date.now();
        if (!answered && (e.type === "text" || e.type === "tool" || e.type === "todos" || e.type === "usage")) {
          answered = true;
          out.push({ type: "log", stream: "system", text: `${harness.label} started`, ms: Date.now() - agentStarted });
        }
        // Every model call of a cloud turn goes through Myrel's proxy, which prices it (proxyModel);
        // the harness's own cost figure would count it twice, and misses calls made around it.
        out.push(e.type === "usage" ? { ...e, costUsd: undefined } : e);
        if (e.type === "usage") {
          const now = Date.now();
          const tokens = e.inputTokens + e.outputTokens;
          out.push({ type: "log", stream: "system", text: `Model step ${++steps} (${tokens.toLocaleString("en")} tokens)`, ms: now - stepStarted });
          stepStarted = now;
        }
      }
    };

    // Only this follow's own last line, never one the run printed, ends it.
    const marker = `::myrel-exit-${run.taskId}::`;
    let exitCode: number | null | undefined;
    for (let attempt = 1; exitCode === undefined && attempt <= MAX_FOLLOWS && !stop.aborted; attempt++) {
      const proc = await container.exec(["bash", "-c", FOLLOW_SCRIPT], {
        env: { MYREL_FROM: String(out.lines), MYREL_EXIT_MARKER: marker },
        user: SANDBOX_USER,
        stdout: "pipe",
        stderr: "pipe",
        signal: stop,
      });
      const lines = new LineSplitter();
      const handle = (line: string) => {
        if (line.startsWith(marker)) {
          const code = line.slice(marker.length).trim();
          exitCode = /^\d+$/.test(code) ? Number(code) : null;
          return;
        }
        if (exitCode !== undefined) return;
        out.counted();
        take(scrub(line));
      };
      try {
        const reader = proc.stdout!.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const line of lines.push(value as Uint8Array)) handle(line);
        }
        for (const line of lines.end()) handle(line);
      } catch (err) {
        if (!stop.aborted) console.warn("sandbox: following the run broke off", err);
      }
    }
    if (stop.aborted) {
      await killed;
      return signal.aborted
        ? { type: "done", ok: false, error: "Cancelled." }
        : { type: "done", ok: false, error: `Timed out after ${run.timeoutSec} seconds.` };
    }
    if (exitCode === undefined || exitCode === null) {
      // Its output could not be followed to the end: nothing would report the rest, so it stops here.
      if (exitCode === undefined) await this.kill(container).catch(() => {});
      return { type: "done", ok: false, error: "The task stopped without finishing." };
    }
    return { type: "done", ok: exitCode === 0, exitCode, ...(exitCode === 0 ? {} : { error: `Exited with code ${exitCode}.` }) };
  }

  /** Stops the running task in the container. */
  private async kill(container: Container) {
    const proc = await container.exec(["bash", "-c", KILL_SCRIPT], { user: SANDBOX_USER });
    await proc.exitCode;
  }

  /**
   * Sends a task's events to the thread in batches. Once a batch arrived, the number of output
   * lines it covered is saved with the run, so a restart follows on from there.
   */
  private async outbox(threadId: string, taskId: string, lines = 0): Promise<Outbox> {
    const thread = await getAgentByName(this.env.THREAD_AGENT, threadId);
    let pending: RunnerEvent[] = [];
    let sending: Promise<void> = Promise.resolve();
    const box: Outbox = {
      lines,
      seen: lines,
      counted: () => void box.seen++,
      push: (...events) => {
        pending.push(...events);
        if (pending.length >= MAX_BATCH) void flush();
      },
      close: async () => {
        clearInterval(timer);
        await flush();
      },
    };
    const flush = () => {
      const batch = pending;
      const upTo = box.seen;
      pending = [];
      sending = sending.then(async () => {
        if (batch.length) await thread.taskEvents(taskId, batch);
        if (upTo === box.lines) return;
        box.lines = upTo;
        const run = await this.ctx.storage.get<StoredRun>(RUN_KEY);
        if (run?.taskId === taskId) await this.ctx.storage.put(RUN_KEY, { ...run, lines: upTo });
      });
      return sending;
    };
    const timer = setInterval(() => void flush().catch((err) => console.error("could not deliver task events", err)), FLUSH_MS);
    return box;
  }

  /** The running container, started from the image on first use. */
  private async container(signal: AbortSignal): Promise<Container> {
    const container = this.ctx.container;
    if (!container) throw new Error("The sandbox container is not configured on this server.");
    // A warm-up already starting it: wait for that rather than starting it again.
    if (this.starting) await abortable(this.starting.catch(() => {}), signal);
    if (container.running) return container;
    await abortable(this.startOnce(container), signal);
    return container;
  }

  private startOnce(container: Container): Promise<void> {
    const start = this.startFrom(container).finally(() => {
      if (this.starting === start) this.starting = null;
    });
    this.starting = start;
    return start;
  }

  private async startFrom(container: Container) {
    if (container.running) await container.destroy();
    // A new container has run nobody's task yet.
    await this.ctx.storage.delete(PRINCIPAL_KEY);
    const image = container.images[IMAGE];
    if (!image) throw new Error("This server's sandbox image is missing. Its admin needs to deploy with `wrangler deploy` (see containers in wrangler.jsonc).");
    const started = Date.now();
    container.start({
      image,
      entrypoint: ENTRYPOINT,
      // Coding agents need the package registries, git hosts and the model API.
      enableInternet: true,
      instance: (this.env.SANDBOX_INSTANCE_TYPE || "standard-1") as ContainerStartupOptions["instance"],
    });
    await container.setInactivityTimeout(IDLE_MS);
    let tries = 0;
    const probe = await execWhenReady(container, ["true"], {}, () => tries++);
    if ((await probe.exitCode) !== 0) throw new Error("The sandbox did not start.");
    this.lastStart = { ms: Date.now() - started, tries: tries + 1 };
    console.log(`sandbox: started in ${clock(this.lastStart.ms)} after ${this.lastStart.tries} tries`);
  }
}

/** A task's events on their way to the thread (see `Sandbox.outbox`). */
type Outbox = {
  /** Output lines the thread has (from the last batch that arrived). */
  lines: number;
  /** Output lines read so far. */
  seen: number;
  counted: () => void;
  push: (...events: RunnerEvent[]) => void;
  close: () => Promise<void>;
};


/** The secrets the container's own filter hides (SCRUB_JS), by name. */
export function scrubbedNames(secrets: Record<string, string>): string[] {
  return Object.entries(secrets)
    .filter(([name, value]) => name !== "MYREL_FILES" && value.length >= MIN_SCRUBBED)
    .map(([name]) => name);
}

/** Replaces the run's secret values in a line of its output. MYREL_FILES is a list of links, not one secret. */
export function secretScrubber(secrets: Record<string, string>): (line: string) => string {
  const values = Object.entries(secrets)
    .filter(([name, value]) => name !== "MYREL_FILES" && value.length >= MIN_SCRUBBED)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  if (!values.length) return (line) => line;
  return (line) => values.reduce((out, value) => (out.includes(value) ? out.split(value).join("[hidden]") : out), line);
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
async function execWhenReady(container: Container, cmd: string[], options: ContainerExecOptions, onRetry?: () => void): Promise<ExecProcess> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await container.exec(cmd, options);
    } catch (err) {
      if (attempt >= 20 || options.signal?.aborted) throw err;
      onRetry?.();
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
