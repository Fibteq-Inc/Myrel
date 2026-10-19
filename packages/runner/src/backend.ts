import type { RunnerEvent, TaskSpec } from "./spec";

/** Where a task's events go. The runner calls it in order; `done` is always last. */
export type TaskSink = (events: RunnerEvent[]) => Promise<void>;

/**
 * Somewhere tasks run: the cloud sandbox (a container per thread) or a
 * person's own machine through `altair-runner`. The thread agent picks a
 * backend, starts the task, and receives its events through the sink until
 * `done`. `start` returns once the task is running, not when it finishes.
 */
export interface RunnerBackend {
  readonly id: string;
  /** Null when this backend can run the task, otherwise why not (shown to the model). */
  unavailable(spec: TaskSpec): string | null;
  start(spec: TaskSpec, secrets: Record<string, string>): Promise<void>;
  cancel(taskId: string): Promise<void>;
}
