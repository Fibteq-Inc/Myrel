import { parseSkillMd } from "@myrel/protocol";
import { BUILTIN_SKILL_FILES } from "./builtin.gen";

/**
 * Myrel's own skills (apps/api/skills), bundled into the Worker by scripts/builtin-skills.mjs.
 * A project setting turns one on (visual-check: ProjectSettings.visualCheck); it then reaches the
 * project's turns like a project skill, without being stored or listed under a person's skills.
 */
export type BuiltinSkillName = "visual-check";

/** The id a built-in skill has in a turn's skill list; a stored skill's id never starts with it. */
export const BUILTIN_ID_PREFIX = "builtin:";

export function builtinSkill(name: BuiltinSkillName): { id: string; name: string; description: string } {
  const files = BUILTIN_SKILL_FILES[name] ?? [];
  const front = parseSkillMd(files.find((f) => f.path === "SKILL.md")?.content ?? "");
  return { id: `${BUILTIN_ID_PREFIX}${name}`, name, description: front.description ?? name };
}

/** A built-in skill's files, base64-encoded like a stored bundle; null for an id that is not one. */
export function builtinBundle(id: string): { path: string; content: string }[] | null {
  if (!id.startsWith(BUILTIN_ID_PREFIX)) return null;
  const files = BUILTIN_SKILL_FILES[id.slice(BUILTIN_ID_PREFIX.length)];
  if (!files) return null;
  const enc = new TextEncoder();
  return files.map((f) => ({ path: f.path, content: base64(enc.encode(f.content)) }));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
