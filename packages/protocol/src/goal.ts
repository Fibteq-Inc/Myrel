import { z } from "zod";

/**
 * A standing goal: a person told the coordinator to keep going ("work through the night", "keep at
 * it until it is done"). While one is open, the coordinator wakes by itself when the last open
 * thread finishes, so the work goes on without anyone writing. At most one per project.
 */
export const Goal = z.object({
  text: z.string(),
  /** When it ends on its own, whatever is left. */
  until: z.string(),
  /** The person who asked for it; threads the coordinator opens for it work for them. */
  createdBy: z.string(),
  createdAt: z.string(),
  /** Turns the coordinator was woken for it without anyone writing. */
  wakes: z.number().int().nonnegative(),
  /** Threads opened while it was open. */
  threads: z.number().int().nonnegative(),
  /** Wakes in a row that started no work. */
  idle: z.number().int().nonnegative(),
});
export type Goal = z.infer<typeof Goal>;

/** A goal ends after this many automatic wakes, so it cannot run up turns all night. */
export const GOAL_MAX_WAKES = 20;
/** Threads opened while a goal is open, beyond which the coordinator starts no more for it. */
export const GOAL_MAX_THREADS = 15;
