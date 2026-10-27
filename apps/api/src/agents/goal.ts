import { type Goal, GOAL_MAX_THREADS, GOAL_MAX_WAKES, nextCronRun, Timestamp } from "@myrel/protocol";
import { z } from "zod";
import { type Tool, tool } from "../llm";

// The goal itself and its limits people see are in the protocol; how the coordinator works with it is here.
export { type Goal, GOAL_MAX_THREADS, GOAL_MAX_WAKES };

/** Automatic wakes in a row that start no work end the goal: nothing useful is left. */
export const GOAL_MAX_IDLE = 2;
/** The longest a goal may stay open. */
export const GOAL_MAX_MS = 24 * 60 * 60 * 1000;
/** While a goal is open and no thread is, the coordinator looks again this often, in case a wake was missed. */
export const GOAL_CHECK_SEC = 30 * 60;

/** Why a goal ended without the coordinator finishing it. */
export type GoalEnd = "deadline" | "wakes" | "idle";

/** The default end of a goal: the next 08:00 in the project's time zone. */
export function defaultGoalUntil(timezone: string, now: Date): Date {
  return nextCronRun("0 8 * * *", timezone, now) ?? new Date(now.getTime() + 12 * 60 * 60 * 1000);
}

export const GOAL_GUIDE = `Standing goals: when a person asks you to keep going on your own for a while ("sabaha kadar devam et, işi bitir", "keep at it until it is done", "work through the night"), call set_goal on their message, in the same turn as starting the first threads. Without a goal you are only woken by new messages, so the work would stop once the first threads finish. While a goal is open, you are woken when the last open thread finishes (and on a check every half hour): look at what the finished threads delivered and what the goal still needs, then start the next piece of work (post one line naming it with post_message, then start_thread on that post) or, when the goal is reached or nothing useful is left, call finish_goal with a short summary for the person. Never set a goal on your own initiative, only on a person's ask. A person saying stop ends it with finish_goal. A goal approves nothing: irreversible steps (deploys, merges, sending outside the project, spending) still need the person in the thread.`;

/** How the coordinator sees the open goal. */
export function renderGoal(goal: Goal, names: Record<string, string>): string {
  return [
    `"${goal.text}"`,
    `Asked by ${names[goal.createdBy] ?? goal.createdBy} at ${goal.createdAt}; ends at ${goal.until}.`,
    `Automatic wakes ${goal.wakes}/${GOAL_MAX_WAKES}, threads opened ${goal.threads}/${GOAL_MAX_THREADS}.`,
  ].join("\n");
}

/** The goal operations the coordinator's tools act through (backed by the ProjectAgent). */
export type GoalHost = {
  /** Opens (or replaces) the goal, posts its line in the project chat and arms the fallback check. */
  setGoal(input: { messageId: string; text: string; until: Date; line: string }): Promise<Goal>;
  /** Closes the open goal and posts the summary. Throws when none is open. */
  finishGoal(summary: string): Promise<void>;
  defaultTimezone: string;
};

export function goalTools(host: GoalHost): Tool[] {
  return [
    tool({
      name: "set_goal",
      description:
        "Keep working toward a person's goal on your own after the first threads finish: you are woken when all threads are done, until the goal is reached or its end time. Only on a person's ask to keep going.",
      input: z.object({
        message_id: z.string().describe("The person's project-chat message asking you to keep going."),
        goal: z.string().min(1).max(2000).describe("What is to be done, in the person's words, with every part of it."),
        until: Timestamp.optional().describe("ISO-8601 time it ends, when the person named one. Default: the next 08:00 in the project's time zone; at most 24 hours."),
        line: z
          .string()
          .min(1)
          .max(300)
          .describe("One short line for the project chat in the person's language: what you will keep doing and until when."),
      }),
      run: async ({ message_id, goal, until, line }) => {
        const now = new Date();
        const end = until ? new Date(until) : defaultGoalUntil(host.defaultTimezone, now);
        if (end.getTime() <= now.getTime()) throw new Error("That end time is already in the past.");
        const capped = new Date(Math.min(end.getTime(), now.getTime() + GOAL_MAX_MS));
        const set = await host.setGoal({ messageId: message_id, text: goal, until: capped, line });
        return `Goal open until ${set.until}. Start its first threads now if you have not yet.`;
      },
    }),
    tool({
      name: "finish_goal",
      description: "End the open goal: it is reached, nothing useful is left, or the person said stop. Posts your summary in the project chat.",
      input: z.object({
        summary: z
          .string()
          .min(1)
          .max(2000)
          .describe("A few lines for the person in their language: what got done, with thread links, and what is left."),
      }),
      run: async ({ summary }) => {
        await host.finishGoal(summary);
        return "Goal finished.";
      },
    }),
  ];
}
