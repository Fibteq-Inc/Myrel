import { z } from "zod";

/**
 * The thread agent's plan: the steps it set out for the work and where each
 * stands. It is shown on the thread as a checklist (`statusText`), so people
 * see what the agent is doing, what it has done and what it chose not to do.
 */
export const PlanStepState = z.enum(["done", "active", "todo", "skipped", "failed"]);
export type PlanStepState = z.infer<typeof PlanStepState>;

export const Plan = z.object({
  title: z.string().trim().min(1).max(80).describe("A few words naming the work, in the person's language."),
  steps: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(120).describe("One step, short, in the person's language."),
        state: PlanStepState,
      }),
    )
    .min(1)
    .max(12),
});
export type Plan = z.infer<typeof Plan>;

/** Steps `next` marks done that `prev` did not (matched by text). */
export function newlyDone(prev: Plan | null, next: Plan): string[] {
  const before = new Set(prev?.steps.filter((s) => s.state === "done").map((s) => s.text) ?? []);
  return next.steps.filter((s) => s.state === "done" && !before.has(s.text)).map((s) => s.text);
}

const MARK: Record<PlanStepState, string> = { done: "✓", active: "✱", todo: "○", skipped: "–", failed: "✗" };

/** The plan as checklist text: a header, a blank line, then one marked step per line. */
export function renderPlan(plan: Plan): string {
  return [plan.title, "", ...plan.steps.map((s) => `${MARK[s.state]} ${s.text}`)].join("\n");
}

/**
 * What the thread shows: the agent's plan, with the checklist of the task it
 * started (run_task) nested under the step it belongs to. Without
 * a plan, the task's checklist alone; without either, nothing.
 */
export function composeStatus(plan: Plan | null, task: string | null): string | null {
  if (!plan) return task;
  const lines = renderPlan(plan).split("\n");
  if (!task) return lines.join("\n");
  // The task's own title is the step it runs under, so only its steps are nested.
  const nested = task
    .split("\n")
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => `  ${l}`);
  const steps = plan.steps;
  let at = steps.findIndex((s) => s.state === "active");
  if (at < 0) at = steps.findLastIndex((s) => s.state === "done" || s.state === "failed");
  if (at < 0) at = steps.length - 1;
  // Steps start after the header and the blank line.
  lines.splice(at + 3, 0, ...nested);
  return lines.join("\n");
}
