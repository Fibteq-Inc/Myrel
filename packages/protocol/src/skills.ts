import { z } from "zod";

/**
 * Skills are Agent Skills (https://agentskills.io): a folder with a SKILL.md (YAML front matter
 * with `name` and `description`, then instructions) and any scripts or references it needs. The
 * thread's agent sees each skill's name and description and opens the rest when the work calls
 * for it. Myrel keeps them, a person's own or a project's, and hands them to every turn:
 * - cloud: written to /workspace/skills in the sandbox (OpenCode also finds them as its own skills);
 * - local: the runner puts them in a folder of the run (Claude Code gets them as a plugin).
 */

/** "user": the person's own, on in the threads that work for them. "project": shared by every thread of a project. */
export const SkillScope = z.enum(["user", "project"]);
export type SkillScope = z.infer<typeof SkillScope>;

/** Agent Skills names: lowercase letters, digits and single hyphens, at most 64 characters. */
export const SkillName = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, digits and hyphens, like pdf-forms.");

export const SkillDescription = z.string().trim().min(1).max(1024);

/** A path inside a skill's folder, like SKILL.md or scripts/fill.py. */
export const SkillPath = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[\w@+=,.~ -]+(\/[\w@+=,.~ -]+)*$/, "Invalid file path.")
  .refine((p) => !p.split("/").some((part) => part === "." || part === ".."), "Invalid file path.");

/** Limits of one skill, so a turn's skills stay small enough to hand over. */
export const SKILL_LIMITS = { files: 200, bytes: 2 * 1024 * 1024, fileBytes: 1024 * 1024 } as const;
/** At most this many skills reach one turn; the rest wait (project ones come first). */
export const MAX_TURN_SKILLS = 40;

/** Where a skill came from. A GitHub skill remembers the commit it was taken from, so updating is a choice. */
export const SkillSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("write") }),
  z.object({ kind: z.literal("upload") }),
  z.object({
    kind: z.literal("github"),
    repo: z.string(),
    /** The skill's folder in the repository ("" for the root). */
    path: z.string(),
    /** The branch or tag asked for; the default branch when absent. */
    ref: z.string().optional(),
    commit: z.string(),
  }),
]);
export type SkillSource = z.infer<typeof SkillSource>;

export const SkillFile = z.object({ path: z.string(), size: z.number().int().nonnegative() });
export type SkillFile = z.infer<typeof SkillFile>;

export const Skill = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  scope: SkillScope,
  source: SkillSource,
  enabled: z.boolean(),
  files: z.array(SkillFile),
  size: z.number().int().nonnegative(),
  /** Whether the caller may change it. */
  canEdit: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Skill = z.infer<typeof Skill>;

/** One skill with its SKILL.md, as the settings show it. */
export const SkillDetail = Skill.extend({ skillMd: z.string() });
export type SkillDetail = z.infer<typeof SkillDetail>;

/** A file sent with a skill, its bytes base64-encoded. */
export const SkillFileUpload = z.object({ path: SkillPath, content: z.string().max(Math.ceil((SKILL_LIMITS.fileBytes * 4) / 3) + 4) });
export type SkillFileUpload = z.infer<typeof SkillFileUpload>;

export const CreateSkillInput = z.discriminatedUnion("kind", [
  /** Written in the settings: Myrel makes its SKILL.md. */
  z.object({ kind: z.literal("write"), name: SkillName, description: SkillDescription, instructions: z.string().max(100_000) }),
  /** A folder (or a .zip opened by the client) with SKILL.md at its top. */
  z.object({ kind: z.literal("upload"), files: z.array(SkillFileUpload).min(1).max(SKILL_LIMITS.files) }),
  /**
   * A public GitHub repository: "owner/repo", a github.com link (…/tree/<ref>/<path>), or a
   * skills.sh link. With more than one skill there, `skill` picks one by name.
   */
  z.object({ kind: z.literal("github"), source: z.string().trim().min(3).max(500), skill: z.string().max(64).optional() }),
]);
export type CreateSkillInput = z.input<typeof CreateSkillInput>;

/** Answer when a GitHub source has several skills and none was picked: add again with one of them. */
export const SkillChoices = z.object({
  error: z.literal("choose_skill"),
  skills: z.array(z.object({ name: z.string(), description: z.string(), path: z.string() })),
});
export type SkillChoices = z.infer<typeof SkillChoices>;

export const UpdateSkillInput = z.object({
  enabled: z.boolean().optional(),
  /** Only for skills written in the settings. */
  description: SkillDescription.optional(),
  instructions: z.string().max(100_000).optional(),
});
export type UpdateSkillInput = z.input<typeof UpdateSkillInput>;

/** What a turn's agent downloads (GET /api/agent-mcp/:threadId/skills with the turn's token). */
export const SkillBundle = z.object({
  skills: z.array(z.object({ name: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })) })),
});
export type SkillBundle = z.infer<typeof SkillBundle>;

/** The front matter of a SKILL.md: the fields Myrel reads. */
export type SkillFrontMatter = { name?: string; description?: string; body: string };

/**
 * Reads `name` and `description` from a SKILL.md's YAML front matter. Handles plain, quoted and
 * block (| and >) values, which is what skills use; other keys are kept in the file untouched.
 */
export function parseSkillMd(text: string): SkillFrontMatter {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { body: text };
  const lines = match[1]!.split(/\r?\n/);
  const out: SkillFrontMatter = { body: text.slice(match[0].length) };
  for (let i = 0; i < lines.length; i++) {
    const m = /^(name|description):[ \t]*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const key = m[1] as "name" | "description";
    let value = m[2]!.trim();
    // Indented lines that follow belong to this value (block scalars and wrapped plain values).
    const more: string[] = [];
    while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]!) || (lines[i + 1]!.trim() === "" && /^[|>]/.test(value)))) {
      more.push(lines[++i]!);
    }
    if (/^[|>][+-]?$/.test(value)) {
      const indent = Math.min(...more.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
      const parts = more.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      value = (value.startsWith("|") ? parts.join("\n") : parts.join(" ").replace(/ {2,}/g, " ")).trim();
    } else {
      if (more.length) value = [value, ...more.map((l) => l.trim())].join(" ");
      value = unquote(value);
    }
    out[key] = value;
  }
  return out;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  // A trailing comment is not part of a plain value.
  return value.replace(/\s+#.*$/, "");
}

/** A SKILL.md for a skill written in the settings. */
export function formatSkillMd(skill: { name: string; description: string; instructions: string }): string {
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions.trim()}\n`;
}

/** Turns one of a person's own skills or connectors on or off in a project (they start off). */
export const SetPersonalInProjectInput = z.object({ on: z.boolean() });
export type SetPersonalInProjectInput = z.infer<typeof SetPersonalInProjectInput>;
