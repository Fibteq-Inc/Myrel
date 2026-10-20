import {
  HARNESSES,
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
import { SANDBOX_HOME, SANDBOX_USER } from "./setup";

export type SandboxRun = { threadId: string; spec: TaskSpec; secrets: Record<string, string> };

/** The image every thread's container starts from (`containers[].images.base` in wrangler.jsonc). */
const IMAGE = "base";
/** Keeps a started container up: work arrives through exec. */
const ENTRYPOINT = ["sleep", "infinity"];
/** How long an idle container stays up before it sleeps. A thread's next task reuses a warm one. */
const IDLE_MS = 10 * 60_000;
/** Events are sent to the thread in batches, at most this often. */
const FLUSH_MS = 750;
const MAX_BATCH = 200;

/**
 * One per thread (named by thread id): the thread's Linux container. It runs
 * one task at a time with the shared task script from @myrel/runner-core and
 * streams the events back to the ThreadAgent through `taskEvents`.
 *
 * Containers start from the image `wrangler deploy` builds from
 * apps/api/sandbox/Dockerfile, with every tool already installed.
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
    this.ctx.waitUntil(this.execute(input.threadId, spec, input.secrets, abort.signal));
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
   * Stops a task. False when this sandbox is not running it: a deploy restarts the sandbox and
   * ends its tasks without a word, and the thread then settles the task itself. A container left
   * over from such a task is stopped too.
   */
  async cancel(taskId: string): Promise<boolean> {
    if (this.current?.taskId === taskId) {
      this.current.abort.abort(new Error("Cancelled"));
      return true;
    }
    if (!this.current && this.ctx.container?.running) await this.ctx.container.destroy().catch(() => {});
    return this.ended === taskId;
  }

  /** Whether the task is still running here (or just ended and is reporting so). */
  async running(taskId: string): Promise<boolean> {
    return this.current?.taskId === taskId || this.ended === taskId;
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
      // Which kind of start it was, so a slow one can be told apart: a fresh container (the image
      // still has to reach the machine), one a warm-up was starting, or one already running.
      // A warm-up in flight counts as running as soon as it called start(), so ask about it first.
      const state = this.starting ? "warming up" : this.ctx.container?.running ? "already running" : "new";
      const container = await this.container(signal);
      const start = state !== "already running" && this.lastStart ? `, first command after ${clock(this.lastStart.ms)} and ${this.lastStart.tries} tries` : "";
      push({ type: "log", stream: "system", text: `Sandbox ready (${state}${start})`, ms: Date.now() - opening });
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
      // What the run prints is kept and shown in the thread; a token it echoes (`env`, a failed git
      // command) is not. This does not stop an agent that means to show one, only accidents.
      const scrub = secretScrubber(secrets);
      const lines = new LineSplitter();
      const reader = proc.stdout!.getReader();
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        for (const line of lines.push(value as Uint8Array)) take(scrub(line));
      }
      for (const line of lines.end()) take(scrub(line));
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
      this.ended = spec.taskId;
      this.current = null;
    }
    push(done);
    try {
      await flush();
    } catch (err) {
      console.error("could not deliver task events", err);
    }
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

/** Values shorter than this are left alone: they would match ordinary output. */
const MIN_SCRUBBED = 12;

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
