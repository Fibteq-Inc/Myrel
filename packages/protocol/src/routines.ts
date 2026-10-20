import { z } from "zod";
import { idPattern } from "./ids";
import { ProjectId, ThreadId, Timestamp } from "./models";

export const RoutineId = z.string().regex(idPattern("routine"));

/** Five-field cron: minute hour day-of-month month day-of-week. */
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;
export const CronExpression = z
  .string()
  .trim()
  .refine((s) => {
    const parts = s.split(/\s+/);
    return parts.length === 5 && parts.every((p) => CRON_FIELD.test(p));
  }, "Expected a five-field cron expression, e.g. 0 9 * * 1-5");

/** IANA time zone name, e.g. Europe/Istanbul. */
export const TimeZone = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown time zone");

/** When a routine runs: on a cron schedule in a time zone, or once at a moment. */
export const RoutineSchedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), cron: CronExpression, timezone: TimeZone.default("UTC") }),
  z.object({ kind: z.literal("once"), at: Timestamp }),
]);
export type RoutineSchedule = z.infer<typeof RoutineSchedule>;
export type RoutineScheduleInput = z.input<typeof RoutineSchedule>;

/** Who a routine wakes: the coordinator (a post in the project chat it routes) or one thread's agent. */
export const RoutineTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("coordinator") }),
  z.object({ kind: z.literal("thread"), threadId: ThreadId }),
]);
export type RoutineTarget = z.infer<typeof RoutineTarget>;

export const Routine = z.object({
  id: RoutineId,
  projectId: ProjectId,
  name: z.string(),
  /** What the woken agent is asked to do on each run. */
  prompt: z.string(),
  target: RoutineTarget,
  schedule: RoutineSchedule,
  paused: z.boolean(),
  /** null when paused, or when a one-shot routine already ran. */
  nextRunAt: Timestamp.nullable(),
  lastRunAt: Timestamp.nullable(),
  runCount: z.number().int().nonnegative(),
  /** A member's user id, or "agent" when Myrel created it. */
  createdBy: z.string(),
  createdAt: Timestamp,
});
export type Routine = z.infer<typeof Routine>;

export const CreateRoutineInput = z.object({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(8000),
  target: RoutineTarget.default({ kind: "coordinator" }),
  schedule: RoutineSchedule,
});
export type CreateRoutineInput = z.infer<typeof CreateRoutineInput>;
export type CreateRoutineInputRaw = z.input<typeof CreateRoutineInput>;

export const UpdateRoutineInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(8000),
    schedule: RoutineSchedule,
    paused: z.boolean(),
  })
  .partial();
export type UpdateRoutineInput = z.infer<typeof UpdateRoutineInput>;
export type UpdateRoutineInputRaw = z.input<typeof UpdateRoutineInput>;
