import { HARNESSES, LineSplitter, parseLine, type RunnerEvent, TaskSpec, taskEnv, taskScript } from "@altair/runner";
import { getAgentByName } from "agents";
import { DurableObject } from "cloudflare:workers";

export type SandboxRun = { threadId: string; spec: TaskSpec; secrets: Record<string, string> };

/** Image key in wrangler.jsonc `containers[].images`. */
const IMAGE = "runner";
/** How long an idle container stays up before it sleeps. A thread's next task reuses a warm one. */
const IDLE_MS = 10 * 60_000;
/** Events are sent to the thread in batches, at most this often. */
const FLUSH_MS = 750;
const MAX_BATCH = 200;

/**
 * One per thread (named by thread id): the thread's Linux container. It runs
 * one task at a time with the shared task script from @altair/runner and
 * streams the events back to the ThreadAgent through `taskEvents`.
 */
export class Sandbox extends DurableObject<Env> {
  private current: { taskId: string; abort: AbortController } | null = null;

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
      const container = await this.container();
      const timeout = AbortSignal.timeout(spec.timeoutSec * 1000);
      const proc = await execWhenReady(container, ["bash", "-c", taskScript()], {
        env: { ...taskEnv(spec, harness), ...secrets },
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

  /** The running container, started on first use. */
  private async container(): Promise<Container> {
    const container = this.ctx.container;
    if (!container) throw new Error("The sandbox container is not configured on this server.");
    if (!container.running) {
      const image = container.images[IMAGE];
      if (!image) throw new Error(`The sandbox image "${IMAGE}" is missing from wrangler.jsonc.`);
      container.start({
        image,
        // Coding agents need the package registries, git hosts and the model API.
        enableInternet: true,
        instance: (this.env.SANDBOX_INSTANCE_TYPE || "standard-1") as ContainerStartupOptions["instance"],
      });
      await container.setInactivityTimeout(IDLE_MS);
    }
    return container;
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
