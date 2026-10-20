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
