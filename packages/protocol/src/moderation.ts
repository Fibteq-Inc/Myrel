import { z } from "zod";
import { ArtifactId, MessageId } from "./models";

/**
 * Reporting content and blocking people (App Store Guideline 1.2). Anyone in a project can report a
 * message (a person's or an agent's) or an artifact; the server keeps the report and emails its
 * admins. Blocking a member hides their messages from the person who blocked them, in every project.
 */

/** Why something is reported. The apps show them in this order, "other" last. */
export const ReportReason = z.enum(["spam", "harassment", "hate", "sexual", "violence", "illegal", "other"]);
export type ReportReason = z.infer<typeof ReportReason>;

export const MAX_REPORT_NOTE = 1000;

export const ReportTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), messageId: MessageId }),
  /** `version`: the one on screen; the latest when absent. */
  z.object({ kind: z.literal("artifact"), artifactId: ArtifactId, version: z.number().int().positive().optional() }),
]);
export type ReportTarget = z.infer<typeof ReportTarget>;

/** `POST /api/projects/:id/reports`. */
export const CreateReportInput = z.object({
  target: ReportTarget,
  reason: ReportReason,
  note: z.string().trim().max(MAX_REPORT_NOTE).optional(),
});
export type CreateReportInput = z.infer<typeof CreateReportInput>;

/** Hidden from the person who blocked its author; true for other people's messages only. */
export function hiddenByBlock(message: { authorKind: string; authorId: string }, blocked: ReadonlySet<string>): boolean {
  return message.authorKind === "user" && blocked.has(message.authorId);
}
