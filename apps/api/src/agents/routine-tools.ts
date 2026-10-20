import {
  CronExpression,
  type Routine,
  type RoutineSchedule,
  type RoutineTarget,
  TimeZone,
  Timestamp,
} from "@myrel/protocol";
import { z } from "zod";
import { type Tool, tool } from "../llm";

/** The routine operations agents' tools act through (backed by the ProjectAgent). */
export type RoutineHost = {
  listRoutines(): Promise<Routine[]> | Routine[];
  createRoutine(input: {
    name: string;
    prompt: string;
    target: RoutineTarget;
    schedule: RoutineSchedule;
  }): Promise<Routine>;
  setPaused(id: string, paused: boolean): Promise<Routine | null>;
  deleteRoutine(id: string): Promise<boolean>;
  defaultTimezone: string;
  /** The thread whose agent holds these tools; null for the coordinator. */
  threadId: string | null;
};

export const ROUTINE_GUIDE = `Routines are scheduled wake-ups. Use create_routine when someone asks for something recurring ("every morning", "each Monday") or for later ("tomorrow at 10", "in two hours"). Pass a five-field cron with an IANA time zone for repeats, or an ISO time for a single run. Use the time zone the person mentioned or implied; otherwise the default. When a routine runs, its prompt reaches its target as a new task. Tell the person in one line what you scheduled and when it first runs.`;

export function routineTools(host: RoutineHost): Tool[] {
  const targetChoices = host.threadId ? (["this_thread", "project_chat"] as const) : (["project_chat"] as const);
  return [
    tool({
      name: "create_routine",
      description:
        "Schedule a routine: a prompt that wakes an agent on a cron schedule or once at a given time." +
        (host.threadId
          ? " By default it wakes you in this thread; project_chat makes each run a new ask the coordinator routes."
          : " Each run posts its prompt in the project chat as a new ask for you to route."),
      input: z.object({
        name: z.string().min(1).max(120).describe("A few words naming the routine."),
        prompt: z.string().min(1).max(8000).describe("What the woken agent should do on each run."),
        cron: CronExpression.optional().describe("Five-field cron for repeats, e.g. '0 9 * * 1-5'."),
        timezone: TimeZone.optional().describe(`IANA time zone for cron. Default ${host.defaultTimezone}.`),
        at: Timestamp.optional().describe("ISO-8601 time for a one-off run, instead of cron."),
        target: z.enum(targetChoices).optional(),
      }),
      run: async ({ name, prompt, cron, timezone, at, target }) => {
        if (!cron === !at) throw new Error("Give exactly one of cron (repeating) or at (one-off).");
        const schedule: RoutineSchedule = cron
          ? { kind: "cron", cron, timezone: timezone ?? host.defaultTimezone }
          : { kind: "once", at: at! };
        const routineTarget: RoutineTarget =
          host.threadId && (target ?? "this_thread") === "this_thread"
            ? { kind: "thread", threadId: host.threadId }
            : { kind: "coordinator" };
        const r = await host.createRoutine({ name, prompt, target: routineTarget, schedule });
        return `Created routine ${r.id}. Next run: ${r.nextRunAt ?? "none"}.`;
      },
    }),
    tool({
      name: "list_routines",
      description: "List this project's routines with their schedules and next runs.",
      input: z.object({}),
      run: async () => {
        const all = await host.listRoutines();
        return all.length ? all.map(renderRoutine).join("\n") : "No routines.";
      },
    }),
    tool({
      name: "set_routine_paused",
      description: "Pause or resume a routine.",
      input: z.object({ routine_id: z.string(), paused: z.boolean() }),
      run: async ({ routine_id, paused }) => {
        const r = await host.setPaused(routine_id, paused);
        if (!r) throw new Error(`No routine ${routine_id}.`);
        return paused ? "Paused." : `Resumed. Next run: ${r.nextRunAt ?? "none"}.`;
      },
    }),
    tool({
      name: "delete_routine",
      description: "Delete a routine for good. Only when a person asked for it.",
      input: z.object({ routine_id: z.string() }),
      run: async ({ routine_id }) => {
        if (!(await host.deleteRoutine(routine_id))) throw new Error(`No routine ${routine_id}.`);
        return "Deleted.";
      },
    }),
  ];
}

export function renderRoutine(r: Routine): string {
  const when =
    r.schedule.kind === "cron" ? `cron "${r.schedule.cron}" (${r.schedule.timezone})` : `once at ${r.schedule.at}`;
  const target = r.target.kind === "thread" ? `thread [${r.target.threadId}]` : "project chat";
  const state = r.paused ? "paused" : r.nextRunAt ? `next ${r.nextRunAt}` : "finished";
  return `- [${r.id}] "${r.name}" · ${when} · wakes ${target} · ${state}`;
}
