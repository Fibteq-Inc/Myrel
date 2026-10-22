import { z } from "zod";

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
 * People's messages that only pick an option on a decision card above them. The card already shows
 * the pick, so clients leave these out instead of repeating it in a bubble of its own.
 */
export function decisionPicks(
  messages: { id: string; authorKind: string; body: string; attachments?: unknown[] | null }[],
): Set<string> {
  const picks = new Set<string>();
  let labels: string[] = [];
  const key = (s: string) => s.trim().toLocaleLowerCase();
  for (const m of messages) {
    if (m.authorKind === "agent") {
      for (const d of decisionsIn(m.body)) labels.push(...d.options.map((o) => key(o.label)));
    } else if (m.authorKind === "user") {
      if (labels.includes(key(m.body)) && !m.attachments?.length) picks.add(m.id);
      labels = [];
    }
  }
  return picks;
}
