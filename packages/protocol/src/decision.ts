import { z } from "zod";
import { idPattern } from "./ids";

/**
 * A question an agent puts to people as a card: 2 to 4 options, one
 * recommended. It travels inside a message body as a fenced ```decision
 * block of JSON, so clients without card support still show readable text.
 */
export const Decision = z.object({
  question: z.string().min(1).max(300),
  options: z
    .array(z.object({ label: z.string().min(1).max(40), consequence: z.string().max(200).default("") }))
    .min(2)
    .max(4),
  /** Index of the recommended option. */
  recommended: z.number().int().nonnegative().optional(),
  /** The step it asks about cannot be undone (an SSH command that deletes, say): the card is red. */
  danger: z.boolean().optional(),
});
export type Decision = z.infer<typeof Decision>;
export type DecisionInput = z.input<typeof Decision>;

export const DECISION_LANG = "decision";

/** The fenced block an agent message carries for a decision card. */
export function formatDecision(decision: DecisionInput): string {
  return "```" + DECISION_LANG + "\n" + JSON.stringify(Decision.parse(decision), null, 2) + "\n```";
}

/** Reads a decision block's JSON; null when it is not a valid decision. */
export function parseDecision(json: string): Decision | null {
  try {
    const result = Decision.safeParse(JSON.parse(json));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** The decision cards in a message body, in order. */
export function decisionsIn(body: string): Decision[] {
  const found: Decision[] = [];
  for (const m of body.matchAll(new RegExp("```" + DECISION_LANG + "\\n([\\s\\S]*?)\\n```", "g"))) {
    const decision = parseDecision(m[1]!);
    if (decision) found.push(decision);
  }
  return found;
}

/**
 * A person's tap on a decision card: the agent message carrying the card, and which card in it
 * (0-based, in the order of the message's decision blocks). Their message's body is the option's
 * label. A message without one answers cards by its text instead (decisionState).
 */
export const DecisionPick = z.object({
  messageId: z.string().regex(idPattern("message")),
  card: z.number().int().nonnegative().max(20),
  /** The card's question, filled in by the server (what clients send is ignored), so prompts can name it. */
  question: z.string().max(300).optional(),
});
export type DecisionPick = z.infer<typeof DecisionPick>;

/**
 * What answered one card: the person's reply (a picked option's label, or their own words), or
 * null when one message of theirs, not addressed to a card, closed several cards at once (so it is
 * no card's answer in particular).
 */
export type DecisionAnswer = string | null;

type DecisionMessage = {
  id: string;
  authorKind: string;
  body: string;
  attachments?: unknown[] | null;
  pick?: DecisionPick | null;
};

/** How a label compares with a person's reply. */
const labelKey = (s: string) => s.trim().toLocaleLowerCase();

/**
 * The answers to the decision cards in a conversation (oldest message first), and the people's
 * messages that only pick an option, which clients leave out because the card shows the pick.
 *
 * - A message with a pick answers that card alone; other open cards stay open.
 * - A message whose text is an option of an open card (one sent by a client without picks, or
 *   typed) answers the oldest open card with that option.
 * - Any other message closes every card still open: with one open card, its text is the answer;
 *   with several, each gets null.
 *
 * `answers` maps an agent message's id to one entry per card in it, undefined while it is open.
 */
export function decisionState(messages: readonly DecisionMessage[]): {
  answers: Map<string, (DecisionAnswer | undefined)[]>;
  picks: Set<string>;
} {
  const answers = new Map<string, (DecisionAnswer | undefined)[]>();
  const picks = new Set<string>();
  let open: { id: string; card: number; labels: string[] }[] = [];
  const answer = (c: { id: string; card: number }, value: DecisionAnswer) => {
    answers.get(c.id)![c.card] = value;
  };
  for (const m of messages) {
    if (m.authorKind === "agent") {
      const cards = decisionsIn(m.body);
      if (!cards.length) continue;
      answers.set(m.id, cards.map(() => undefined));
      cards.forEach((d, card) => open.push({ id: m.id, card, labels: d.options.map((o) => labelKey(o.label)) }));
      continue;
    }
    if (m.authorKind !== "user") continue;
    const bare = !m.attachments?.length;
    if (m.pick) {
      const { messageId, card } = m.pick;
      const at = open.findIndex((c) => c.id === messageId && c.card === card);
      if (at >= 0) {
        answer(open[at]!, m.body);
        open.splice(at, 1);
      }
      // Shown on its card; a second tap on a card already answered (from another device) too.
      if (bare && (answers.get(messageId)?.length ?? 0) > card) picks.add(m.id);
      continue;
    }
    const text = labelKey(m.body);
    const at = bare ? open.findIndex((c) => c.labels.includes(text)) : -1;
    if (at >= 0) {
      answer(open[at]!, m.body);
      open.splice(at, 1);
      picks.add(m.id);
      continue;
    }
    for (const c of open) answer(c, open.length === 1 ? m.body : null);
    open = [];
  }
  return { answers, picks };
}

/**
 * People's messages that only pick an option on a decision card above them. The card already shows
 * the pick, so clients leave these out instead of repeating it in a bubble of its own.
 */
export function decisionPicks(messages: readonly DecisionMessage[]): Set<string> {
  return decisionState(messages).picks;
}

/** Index of the option an answer picked, matched on its label; -1 when none. */
export function chosenOption(decision: Decision, answer: DecisionAnswer | undefined): number {
  if (answer == null) return -1;
  const a = labelKey(answer);
  return decision.options.findIndex((o) => labelKey(o.label) === a);
}

/**
 * Which of a message's decision blocks `decision` is, so a renderer that meets the blocks one by
 * one finds its card's answer. -1 when it is not one of them.
 */
export function decisionIndex(body: string, decision: Decision): number {
  const json = JSON.stringify(decision);
  return decisionsIn(body).findIndex((d) => JSON.stringify(d) === json);
}
