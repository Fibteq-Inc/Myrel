import { z } from "zod";

/**
 * A project with the visual check on (ProjectSettings.visualCheck) has interface work checked
 * before its pull request: the thread that made the change asks for a check, Myrel opens a separate
 * evaluator thread that takes screenshots and judges them, and the result comes back to the first
 * thread. The thread shows each round as a card: a message body holding a fenced ```visual-check
 * block of JSON, which Myrel edits as the round goes from running to its result.
 */

/** At most this many rounds a piece of work gets before a person has to say whether to go on. */
export const VISUAL_CHECK_ROUNDS = 2;

/**
 * running: the evaluator is at work. passed / failed: its verdict. partial: the deterministic checks
 * passed but no model that reads images judged the look. not_checked: the check could not run (no
 * browser, the evaluator stopped, the thread works in the cloud).
 */
export const VisualCheckStatus = z.enum(["running", "passed", "failed", "partial", "not_checked"]);
export type VisualCheckStatus = z.infer<typeof VisualCheckStatus>;

const Score = z.number().int().min(1).max(10);

export const VisualCheckCard = z.object({
  id: z.string(),
  round: z.number().int().min(1),
  status: VisualCheckStatus,
  /** The thread doing the check. */
  evaluatorThreadId: z.string().nullable().default(null),
  /** The project files folder its screenshots and report go to (checks/<id>/<round>). */
  folder: z.string(),
  branch: z.string().max(255).optional(),
  /** Which CLI and model judged it, so people can compare evaluators. */
  evaluator: z.object({ cli: z.string(), model: z.string(), effort: z.string().optional() }).optional(),
  /** Whether that model read the probe image back, i.e. really saw the screenshots. */
  vision: z.enum(["passed", "failed", "skipped"]).optional(),
  scores: z.object({ functionality: Score, craft: Score, design: Score, originality: Score }).optional(),
  deterministic: z.object({ shots: z.number(), blocking: z.number(), warnings: z.number() }).optional(),
  /**
   * What must change, each with its screenshot (a project file path) and, when the finding could be
   * located, `image`: that screenshot with the finding framed in red and numbered `n`.
   */
  blocking: z
    .array(
      z.object({
        n: z.number().int().min(1).optional(),
        screen: z.string().max(200),
        problem: z.string().max(2000),
        evidence: z.string().max(400),
        image: z.string().max(400).optional(),
      }),
    )
    .max(20)
    .default([]),
  /** What the work had to do, each checked on screen or by walking a flow (the logic part of the check). */
  acceptance: z
    .array(z.object({ criterion: z.string().max(500), met: z.boolean() }))
    .max(30)
    .default([]),
  /** Contact sheets (project file paths): every width and theme of a screen side by side. */
  sheets: z.array(z.string().max(400)).max(12).default([]),
  /** Screens that differ from the approved screenshots, as pictures of what changed (project file paths). */
  diffs: z.array(z.string().max(400)).max(12).default([]),
  /** A person accepted the round as it is, despite its findings. */
  acceptedBy: z.string().max(120).optional(),
  /** A person made this round's screenshots the approved ones that later checks compare against. */
  baselineBy: z.string().max(120).optional(),
  /** The full result for people (a project file path). */
  summary: z.string().max(400).optional(),
  /** Why it could not run, for not_checked; otherwise a short note. */
  note: z.string().max(600).optional(),
  /** A command the computer's owner runs so the next round can start (shown to copy). */
  command: z.string().max(300).optional(),
});
export type VisualCheckCard = z.infer<typeof VisualCheckCard>;
export type VisualCheckCardInput = z.input<typeof VisualCheckCard>;

export const VISUAL_CHECK_LANG = "visual-check";

/** The project files folder holding the approved screenshots later checks compare against. */
export const VISUAL_CHECK_BASELINE = "checks/baseline";

/** What a person can do from a round's card: accept it as it is, or make its screenshots the approved ones. */
export const VisualCheckAction = z.enum(["accept", "baseline"]);
export type VisualCheckAction = z.infer<typeof VisualCheckAction>;

/** The message body for a visual check card. */
export function formatVisualCheck(card: VisualCheckCardInput): string {
  return "```" + VISUAL_CHECK_LANG + "\n" + JSON.stringify(VisualCheckCard.parse(card), null, 2) + "\n```";
}

/** The card a message body carries, or null when the body is not one. */
export function parseVisualCheck(body: string): VisualCheckCard | null {
  const m = /^```visual-check\n([\s\S]*)\n```$/.exec(body.trim());
  if (!m) return null;
  try {
    const result = VisualCheckCard.safeParse(JSON.parse(m[1]!));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
