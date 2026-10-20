import type { Decision, Message } from "@myrel/protocol";

export { DECISION_LANG, type Decision, parseDecision } from "@myrel/protocol";

/**
 * For each agent message, the first later message by a person in the same
 * conversation: that is the answer to any decision card it carries.
 */
export function decisionAnswers(messages: Message[]): Map<string, string> {
  const answers = new Map<string, string>();
  let pending: string[] = [];
  for (const m of messages) {
    if (m.authorKind === "agent") pending.push(m.id);
    else if (m.authorKind === "user") {
      for (const id of pending) answers.set(id, m.body);
      pending = [];
    }
  }
  return answers;
}

/** Index of the option an answer picked, matched on its label; -1 when none. */
export function chosenOption(decision: Decision, answer: string | undefined): number {
  if (answer === undefined) return -1;
  const a = answer.trim().toLocaleLowerCase();
  return decision.options.findIndex((o) => o.label.trim().toLocaleLowerCase() === a);
}
