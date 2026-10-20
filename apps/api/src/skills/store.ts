import { createDb, schema } from "@myrel/db";
import { MAX_TURN_SKILLS, parseSkillMd, type Skill, SKILL_LIMITS, SkillName, SkillPath, type SkillScope } from "@myrel/protocol";
import { and, asc, eq } from "drizzle-orm";

const { projectSkills, skills } = schema;

export type SkillRow = typeof skills.$inferSelect;

/** A skill's files, as bytes. */
export type SkillFiles = Map<string, Uint8Array>;

export type SkillOwner = { userId: string } | { projectId: string };

export function ownerWhere(owner: SkillOwner) {
  return "userId" in owner ? eq(skills.ownerId, owner.userId) : eq(skills.projectId, owner.projectId);
}

export function ownerScope(owner: SkillOwner): SkillScope {
  return "userId" in owner ? "user" : "project";
}

export function toSkill(row: SkillRow, canEdit: boolean): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.projectId ? "project" : "user",
    source: row.source,
    enabled: row.enabled,
    files: row.files,
    size: row.size,
    canEdit,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function findSkill(env: Env, owner: SkillOwner, id: string): Promise<SkillRow | null> {
  const [row] = await createDb(env.DB)
    .select()
    .from(skills)
    .where(and(eq(skills.id, id), ownerWhere(owner)));
  return row ?? null;
}

/** The R2 key of a skill's files: one JSON bundle, so a turn reads each skill in one go. */
export function bundleKey(id: string) {
  return `skills/${id}.json`;
}

type StoredBundle = { files: { path: string; content: string }[] };

/** Removes the files of every skill of an owner, before its rows go (they cascade with the person or project). */
export async function deleteOwnerFiles(env: Env, owner: SkillOwner): Promise<void> {
  const rows = await createDb(env.DB).select({ id: skills.id }).from(skills).where(ownerWhere(owner));
  if (rows.length) await env.FILES.delete(rows.map((r) => bundleKey(r.id)));
}

export async function writeFiles(env: Env, id: string, files: SkillFiles): Promise<void> {
  const bundle: StoredBundle = { files: [...files].map(([path, bytes]) => ({ path, content: toBase64(bytes) })) };
  await env.FILES.put(bundleKey(id), JSON.stringify(bundle), { httpMetadata: { contentType: "application/json" } });
}

/** A skill's files, base64-encoded, as stored. Empty when the bundle is gone. */
export async function readBundle(env: Env, id: string): Promise<StoredBundle["files"]> {
  const object = await env.FILES.get(bundleKey(id));
  if (!object) return [];
  return ((await object.json()) as StoredBundle).files;
}

export async function readSkillMd(env: Env, id: string): Promise<string> {
  const file = (await readBundle(env, id)).find((f) => f.path === "SKILL.md");
  return file ? new TextDecoder().decode(fromBase64(file.content)) : "";
}

export type CheckedSkill = { name: string; description: string; files: { path: string; size: number }[]; size: number };

/**
 * Checks a skill's files: SKILL.md at the top with a valid name and a description, file paths
 * and sizes within limits. `fallbackName` names a skill whose SKILL.md has none (its folder's name).
 */
export function checkSkillFiles(files: SkillFiles, fallbackName?: string): { ok: true; skill: CheckedSkill } | { ok: false; error: string } {
  const md = files.get("SKILL.md");
  if (!md) return { ok: false, error: "A skill needs a SKILL.md file at the top of its folder." };
  if (files.size > SKILL_LIMITS.files) return { ok: false, error: `A skill can have at most ${SKILL_LIMITS.files} files.` };
  let size = 0;
  const list: CheckedSkill["files"] = [];
  for (const [path, bytes] of files) {
    if (!SkillPath.safeParse(path).success) return { ok: false, error: `Invalid file path: ${path.slice(0, 200)}` };
    if (bytes.length > SKILL_LIMITS.fileBytes) return { ok: false, error: `${path} is larger than ${SKILL_LIMITS.fileBytes / 1024 / 1024} MB.` };
    size += bytes.length;
    list.push({ path, size: bytes.length });
  }
  if (size > SKILL_LIMITS.bytes) return { ok: false, error: `A skill can be at most ${SKILL_LIMITS.bytes / 1024 / 1024} MB.` };
  const front = parseSkillMd(new TextDecoder().decode(md));
  const name = front.name ?? fallbackName;
  if (!name || !SkillName.safeParse(name).success) {
    return { ok: false, error: `SKILL.md needs a name of lowercase letters, digits and hyphens (got "${(name ?? "").slice(0, 80)}").` };
  }
  const description = front.description?.trim();
  if (!description) return { ok: false, error: "SKILL.md needs a description: what the skill does and when to use it." };
  list.sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)));
  return { ok: true, skill: { name, description: description.slice(0, 1024), files: list, size } };
}

/** One skill as a turn of the thread's agent gets it. */
export type TurnSkill = { id: string; name: string; description: string };

/**
 * The skills a thread's agent gets this turn: the project's, then those of the person the thread
 * works for that they turned on in this project. A person's skill with the same name as a project's is left out (the project's wins).
 */
export async function turnSkills(env: Env, where: { projectId: string; userId: string | null }): Promise<TurnSkill[]> {
  const db = createDb(env.DB);
  const project = await db
    .select()
    .from(skills)
    .where(and(eq(skills.projectId, where.projectId), eq(skills.enabled, true)))
    .orderBy(asc(skills.name));
  // A person's own skills only where they turned them on for this project.
  const own = where.userId
    ? (
        await db
          .select({ skill: skills })
          .from(skills)
          .innerJoin(projectSkills, and(eq(projectSkills.skillId, skills.id), eq(projectSkills.projectId, where.projectId)))
          .where(and(eq(skills.ownerId, where.userId), eq(skills.enabled, true)))
          .orderBy(asc(skills.name))
      ).map((r) => r.skill)
    : [];
  const seen = new Set<string>();
  const out: TurnSkill[] = [];
  for (const row of [...project, ...own]) {
    if (seen.has(row.name) || out.length >= MAX_TURN_SKILLS) continue;
    seen.add(row.name);
    out.push({ id: row.id, name: row.name, description: row.description });
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
