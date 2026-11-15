import { z } from "zod";

/**
 * A research by Claude (a thread agent's start_research, run on Claude Managed Agents on the
 * approver's own Anthropic key) shows in its thread as a card: a message body holding a fenced
 * ```research block of JSON, which Myrel edits as the run goes. It shows the spend against the
 * budget, how many searches and pages it took, its last few steps, and at the end the short answer
 * and the report. The project lists every research it had (ResearchSummary).
 */

/**
 * running: the researcher is at work. budget: it paused at its budget and a card asks whether to
 * go on. done: it finished (partial: stopped at its budget, the time limit or by a person, with
 * what it had). failed: it ended without a report.
 */
export const ResearchStatus = z.enum(["running", "budget", "done", "failed"]);
export type ResearchStatus = z.infer<typeof ResearchStatus>;

/** One step of the run: a web search (its query) or a page it read (its address). */
export const ResearchStep = z.object({
  kind: z.enum(["search", "read"]),
  text: z.string().max(400),
});
export type ResearchStep = z.infer<typeof ResearchStep>;

export const ResearchCard = z.object({
  id: z.string(),
  title: z.string().max(200),
  status: ResearchStatus,
  /** Why it stopped early, for a partial result. */
  partial: z.enum(["budget", "time", "stopped"]).optional(),
  spentCents: z.number().int().nonnegative(),
  budgetCents: z.number().int().positive(),
  searches: z.number().int().nonnegative().default(0),
  pages: z.number().int().nonnegative().default(0),
  /** The newest steps, newest first. */
  steps: z.array(ResearchStep).max(6).default([]),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  model: z.string().max(80),
  approverName: z.string().max(120).optional(),
  /** Who stopped it, when a person did. */
  stoppedBy: z.string().max(120).optional(),
  /** The report in the project files, once there is one. */
  report: z.string().max(400).optional(),
  /** The report's opening (its short answer), for the card. */
  summary: z.string().max(600).optional(),
  /** Why it failed, for failed. */
  note: z.string().max(600).optional(),
});
export type ResearchCard = z.infer<typeof ResearchCard>;
export type ResearchCardInput = z.input<typeof ResearchCard>;

export const RESEARCH_LANG = "research";

/** The message body for a research card. */
export function formatResearch(card: ResearchCardInput): string {
  return "```" + RESEARCH_LANG + "\n" + JSON.stringify(ResearchCard.parse(card), null, 2) + "\n```";
}

/** The card a message body carries, or null when the body is not one. */
export function parseResearch(body: string): ResearchCard | null {
  const m = /^```research\n([\s\S]*)\n```$/.exec(body.trim());
  if (!m) return null;
  try {
    const result = ResearchCard.safeParse(JSON.parse(m[1]!));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** What a person can do from a running research's card. */
export const ResearchAction = z.enum(["stop"]);
export type ResearchAction = z.infer<typeof ResearchAction>;

/** One research in the project's list. */
export const ResearchSummary = z.object({
  id: z.string(),
  threadId: z.string(),
  threadTitle: z.string(),
  title: z.string(),
  status: ResearchStatus,
  partial: z.enum(["budget", "time", "stopped"]).optional(),
  spentCents: z.number().int().nonnegative(),
  budgetCents: z.number().int().positive(),
  approverName: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  report: z.string().optional(),
});
export type ResearchSummary = z.infer<typeof ResearchSummary>;
