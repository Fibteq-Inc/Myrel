import { z } from "zod";
import { AuthorKind, Timestamp } from "./models";
import { FilePath } from "./paths";

/**
 * Project knowledge: what every agent in a project reads before it works.
 * Instructions are set by members; memory is notes agents (and members) keep;
 * files are the project's shared folder, stored in R2.
 */

export const MAX_INSTRUCTIONS_LENGTH = 16_000;
export const MAX_MEMORY_LENGTH = 16_000;
/** Largest file a member can upload or an agent can write. */
export const MAX_FILE_SIZE = 25 * 1024 * 1024;
/** Most attachments on one message. */
export const MAX_ATTACHMENTS = 10;
/** Folder message uploads land in, inside the project files. */
export const UPLOADS_FOLDER = "uploads";
/** The memory file every agent reads in full; the others it sees by name and description. */
export const MEMORY_INDEX = "MEMORY";

export const ProjectFile = z.object({
  path: FilePath,
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  updatedAt: Timestamp,
  updatedByKind: AuthorKind,
  updatedBy: z.string(),
});
export type ProjectFile = z.infer<typeof ProjectFile>;

export const MemoryName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u, "Use letters, numbers, spaces, dots, dashes or underscores");

export const MemoryEntry = z.object({
  name: MemoryName,
  /** One line saying when to read it. */
  description: z.string().max(300),
  content: z.string().max(MAX_MEMORY_LENGTH),
  updatedAt: Timestamp,
  updatedByKind: AuthorKind,
  updatedBy: z.string(),
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

export const PutMemoryInput = MemoryEntry.pick({ description: true, content: true });
export type PutMemoryInput = z.infer<typeof PutMemoryInput>;

export const Instructions = z.object({
  text: z.string().max(MAX_INSTRUCTIONS_LENGTH),
  updatedAt: Timestamp.nullable(),
  updatedBy: z.string().nullable(),
});
export type Instructions = z.infer<typeof Instructions>;

export const PutInstructionsInput = Instructions.pick({ text: true });

/** What changed, so clients refetch only that list. */
export const KnowledgeKind = z.enum(["files", "memory", "instructions"]);
export type KnowledgeKind = z.infer<typeof KnowledgeKind>;
