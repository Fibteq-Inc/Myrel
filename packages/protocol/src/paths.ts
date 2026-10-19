import { z } from "zod";

/**
 * A path inside the project files: `/`-separated segments, no leading slash,
 * no `.` or `..` segments, no control characters.
 */
export const FilePath = z
  .string()
  .min(1)
  .max(512)
  .refine(isValidFilePath, "Invalid path: use segments like notes/plan.md, without .. or a leading /");

export function isValidFilePath(path: string): boolean {
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  const segments = path.split("/");
  return segments.every((s) => s.length > 0 && s.length <= 255 && s !== "." && s !== "..");
}

/** Normalizes what a person or a model types (leading slashes, `./`, repeated slashes) into a FilePath. */
export function normalizeFilePath(input: string): string {
  return input
    .trim()
    .replace(/^\/mnt\/project-files\//, "")
    .split("/")
    .filter((s) => s && s !== ".")
    .join("/");
}
