/**
 * A thread agent's plan travels as a message in the thread: a fenced ```plan
 * block holding the checklist text (a title line, then ✓ ✱ ○ – ✗ steps).
 * The agent edits that message as steps finish, so the card stays where the
 * work started and keeps its final state once the work is done. Clients
 * without card support still show the checklist as text.
 */
export const PLAN_LANG = "plan";

/** The message body for a plan card. */
export function formatPlan(checklist: string): string {
  return "```" + PLAN_LANG + "\n" + checklist + "\n```";
}

/** The checklist inside a plan card's body, or null when the body is not one. */
export function planChecklist(body: string): string | null {
  const m = /^```plan\n([\s\S]*)\n```$/.exec(body);
  return m ? m[1]! : null;
}

/**
 * When the agent adds, drops or fails plan steps while its plan card sits
 * further up the conversation, a short note at the end says what changed: a
 * fenced ```plan-update block, one step per line marked + (added), - (dropped)
 * or ✗ (failed). Changes in a row land in the same note. Ticking steps off
 * never makes one; the pinned progress line shows that.
 */
export const PLAN_UPDATE_LANG = "plan-update";

export type PlanUpdate = { added: string[]; removed: string[]; failed: string[] };

const UPDATE_MARKS = { added: "+", removed: "-", failed: "✗" } as const;

/** The message body for a plan update note. */
export function formatPlanUpdate(u: PlanUpdate): string {
  const lines = (Object.keys(UPDATE_MARKS) as (keyof PlanUpdate)[]).flatMap((k) => u[k].map((s) => `${UPDATE_MARKS[k]} ${s}`));
  return "```" + PLAN_UPDATE_LANG + "\n" + lines.join("\n") + "\n```";
}

/** The changes in a plan update note's body, or null when the body is not one. */
export function parsePlanUpdate(body: string): PlanUpdate | null {
  const m = /^```plan-update\n([\s\S]*)\n```$/.exec(body);
  if (!m) return null;
  const u: PlanUpdate = { added: [], removed: [], failed: [] };
  for (const line of m[1]!.split("\n")) {
    const key = (Object.keys(UPDATE_MARKS) as (keyof PlanUpdate)[]).find((k) => line.startsWith(UPDATE_MARKS[k] + " "));
    if (key) u[key].push(line.slice(2).trim());
  }
  return u;
}

/** Whether a message is the plan's own bookkeeping (its card or an update note) rather than something said. */
export function isPlanMessage(body: string): boolean {
  return planChecklist(body) !== null || parsePlanUpdate(body) !== null;
}

export type ChecklistItem = {
  state: "done" | "active" | "todo" | "skipped" | "failed";
  text: string;
  /** 0 for a step of the agent's plan; 1 and 2 for the steps of a task nested under it. */
  depth: number;
};

/**
 * Parses a thread's checklist: a header line, then ✓ / ✱ / ○ steps (✗ marks a
 * failed step, – one the agent decided to skip). Indented steps belong to the
 * step above them.
 */
export function parseChecklist(text: string): { title: string; items: ChecklistItem[] } {
  const marks: Record<string, ChecklistItem["state"]> = { "✓": "done", "✱": "active", "○": "todo", "–": "skipped", "✗": "failed" };
  const items: ChecklistItem[] = [];
  let title = "";
  for (const raw of text.split("\n")) {
    const indent = raw.length - raw.trimStart().length;
    // The just-finished step may be bolded: **✓ step**.
    const line = raw.trim().replace(/^\*\*(.*)\*\*$/, "$1").trim();
    if (!line) continue;
    const state = marks[line[0]!];
    if (state) items.push({ state, text: line.slice(1).trim(), depth: Math.min(2, Math.floor(indent / 2)) });
    else if (!title && items.length === 0) title = line;
  }
  return { title, items };
}

/** How far a checklist is: its top-level steps done, out of those not skipped. */
export function checklistProgress(items: ChecklistItem[]): { done: number; total: number } {
  const steps = items.filter((i) => i.depth === 0 && i.state !== "skipped");
  return { done: steps.filter((i) => i.state === "done").length, total: steps.length };
}

/** The step a thread's checklist is on, the innermost active one, and how far its plan is ("2/5"). */
export function checklistStep(text: string): { step: string | null; progress: string | null } {
  const { items } = parseChecklist(text);
  const { done, total } = checklistProgress(items);
  return { step: items.findLast((i) => i.state === "active")?.text ?? null, progress: total > 1 ? `${done}/${total}` : null };
}
