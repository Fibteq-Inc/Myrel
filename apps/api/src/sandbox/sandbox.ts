import { HARNESSES, LineSplitter, parseLine, type RunnerEvent, TaskSpec, taskEnv, taskScript } from "@altair/runner-core";
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

type BaseSnapshot = { version: string; snapshot: ContainerSnapshot };

/**
 * One per thread (named by thread id): the thread's Linux container. It runs
 * one task at a time with the shared task script from @altair/runner-core and
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
      push({ type: "log", stream: "system", text: `Starting ${harness.label} in the sandbox…` });
      const container = await this.container((text) => push({ type: "log", stream: "system", text }));
      const timeout = AbortSignal.timeout(spec.timeoutSec * 1000);
      const proc = await execWhenReady(container, ["bash", "-c", taskScript()], {
        env: { HOME: SANDBOX_HOME, CI: "1", GIT_TERMINAL_PROMPT: "0", ...taskEnv(spec, harness), ...secrets },
        user: SANDBOX_USER,
        stdout: "pipe",
        stderr: "combined",
        signal: AbortSignal.any([signal, timeout]),
      });
      const lines = new LineSplitter();
      const reader = proc.stdout!.getReader();
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        for (const line of lines.push(value as Uint8Array)) push(...parseLine(harness, line));
      }
      for (const line of lines.end()) push(...parseLine(harness, line));
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
  private async container(log: (text: string) => void): Promise<Container> {
    const container = this.ctx.container;
    if (!container) throw new Error("The sandbox container is not configured on this server.");
    if (container.running) return container;
    const base = this.env.SANDBOX.getByName(BASE);
    let id = (await base.baseSnapshot(false))?.id;
    if (!id) {
      log("Preparing the sandbox tools. This happens once and takes a few minutes…");
      id = (await base.baseSnapshot(true))!.id;
    }
    try {
      await this.startFrom(container, id);
    } catch (err) {
      // Snapshots expire after 30 unused days: rebuild once.
      console.warn("sandbox: starting from the base snapshot failed, rebuilding it", err);
      log("Preparing the sandbox tools again. This takes a few minutes…");
      await this.startFrom(container, (await base.baseSnapshot(true, id))!.id);
    }
    return container;
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

  private async buildBase(): Promise<BaseSnapshot> {
    const container = this.ctx.container;
    if (!container) throw new Error("The sandbox container is not configured on this server.");
    if (container.running) await container.destroy();
    container.start({ image: BASE_IMAGE, entrypoint: ENTRYPOINT, enableInternet: true, instance: "standard-1" });
    try {
      const proc = await execWhenReady(container, ["bash", "-c", SETUP_SCRIPT], { stdout: "pipe", stderr: "combined" });
      const output = await new Response(proc.stdout).text();
      const code = await proc.exitCode;
      if (code !== 0) throw new Error(`Preparing the sandbox failed (exit ${code}): ${output.slice(-2000)}`);
      const snapshot = await container.snapshotContainer({ name: `altair-base-${SETUP_VERSION}` });
      const base = { version: SETUP_VERSION, snapshot };
      await this.ctx.storage.put("base", base);
      return base;
    } finally {
      await container.destroy().catch(() => {});
    }
  }
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
