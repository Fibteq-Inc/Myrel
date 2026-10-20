import { createDb, schema } from "@myrel/db";
import { createId, CreateSkillInput, formatSkillMd, parseSkillMd, type SkillSource, UpdateSkillInput } from "@myrel/protocol";
import { and, asc, eq, ne } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { canAddSkill } from "../extensions";
import { type AppEnv, requireUser } from "../middleware";
import { type GithubSource, importFromGithub, parseGithubSource, pickSkill } from "../skills/github";
import {
  bundleKey,
  type CheckedSkill,
  checkSkillFiles,
  findSkill,
  fromBase64,
  ownerWhere,
  readSkillMd,
  type SkillFiles,
  type SkillOwner,
  type SkillRow,
  toSkill,
  writeFiles,
} from "../skills/store";
import type { z } from "zod";
import { findMembership } from "./projects";

const { skills } = schema;

/** Who owns the skills a request is about, and whether the caller may change them. */
type Scope = { owner: SkillOwner; canEdit: boolean };

type Prepared = { ok: true; skill: CheckedSkill; files: SkillFiles; source: SkillSource } | { ok: false; status: 400 | 404 | 409 | 413 | 502; body: object };

/** The files and source of a new skill, checked. */
async function prepare(data: z.output<typeof CreateSkillInput>): Promise<Prepared> {
  if (data.kind === "write") {
    const files: SkillFiles = new Map([["SKILL.md", new TextEncoder().encode(formatSkillMd(data))]]);
    return checked(files, { kind: "write" });
  }
  if (data.kind === "upload") {
    const files: SkillFiles = new Map();
    for (const f of data.files) {
      try {
        files.set(f.path, fromBase64(f.content));
      } catch {
        return { ok: false, status: 400, body: { error: "invalid_input", message: `${f.path} is not valid base64.` } };
      }
    }
    return checked(files, { kind: "upload" });
  }
  const source = parseGithubSource(data.source);
  if (!source) {
    return { ok: false, status: 400, body: { error: "invalid_input", message: "Give a GitHub repository (owner/repo), a github.com link or a skills.sh link." } };
  }
  return fromGithub({ ...source, ...(data.skill && { skill: data.skill }) });
}

async function fromGithub(source: GithubSource): Promise<Prepared> {
  const found = await importFromGithub(source);
  if (!found.ok) return { ok: false, status: found.status, body: { error: "import_failed", message: found.error } };
  const skill = pickSkill(found.skills, source.skill);
  if (!skill) {
    if (source.skill) return { ok: false, status: 404, body: { error: "import_failed", message: `No skill named ${source.skill} there.` } };
    return {
      ok: false,
      status: 409,
      body: { error: "choose_skill", skills: found.skills.map((s) => ({ name: s.name, description: s.description.slice(0, 300), path: s.path })) },
    };
  }
  const repo = `${source.owner}/${source.repo}`;
  return checked(skill.files, { kind: "github", repo, path: skill.path, ...(source.ref && { ref: source.ref }), commit: found.commit }, skill.path.split("/").pop());
}

function checked(files: SkillFiles, source: SkillSource, fallbackName?: string): Prepared {
  const result = checkSkillFiles(files, fallbackName);
  if (!result.ok) return { ok: false, status: 400, body: { error: "invalid_skill", message: result.error } };
  return { ok: true, skill: result.skill, files, source };
}

async function nameTaken(env: Env, owner: SkillOwner, name: string, except?: string): Promise<boolean> {
  const rows = await createDb(env.DB)
    .select({ id: skills.id })
    .from(skills)
    .where(and(ownerWhere(owner), eq(skills.name, name), ...(except ? [ne(skills.id, except)] : [])));
  return rows.length > 0;
}

/**
 * The same routes for a person's own skills (/api/account/skills) and a project's
 * (/api/projects/:id/skills): list, read one (with its SKILL.md), add, change, update from
 * GitHub, and remove.
 */
function skillRoutes(scope: (c: Context<AppEnv>) => Promise<Scope | null>) {
  return new Hono<AppEnv>()
    .use(requireUser)
    .get("/", async (c) => {
      const s = await scope(c);
      if (!s) return c.json({ error: "not_found" }, 404);
      const rows = await createDb(c.env.DB).select().from(skills).where(ownerWhere(s.owner)).orderBy(asc(skills.name));
      return c.json({ skills: rows.map((r) => toSkill(r, s.canEdit)) });
    })
    .get("/:skillId", async (c) => {
      const s = await scope(c);
      if (!s) return c.json({ error: "not_found" }, 404);
      const row = await findSkill(c.env, s.owner, c.req.param("skillId"));
      if (!row) return c.json({ error: "not_found" }, 404);
      return c.json({ skill: { ...toSkill(row, s.canEdit), skillMd: await readSkillMd(c.env, row.id) } });
    })
    .post("/", async (c) => {
      const s = await scope(c);
      if (!s) return c.json({ error: "not_found" }, 404);
      if (!s.canEdit) return c.json({ error: "forbidden", message: "Only project owners and admins can add skills." }, 403);
      const input = CreateSkillInput.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
      const allowed = await canAddSkill(c.env, s.owner);
      if (!allowed.ok) return c.json({ error: "limit_reached", message: allowed.reason }, 402);
      const prepared = await prepare(input.data);
      if (!prepared.ok) return c.json(prepared.body, prepared.status);
      const { skill, files, source } = prepared;
      if (await nameTaken(c.env, s.owner, skill.name)) {
        return c.json({ error: "name_taken", message: `There is already a skill named ${skill.name}.` }, 409);
      }
      const id = createId("skill");
      const now = new Date();
      const row: SkillRow = {
        id,
        ownerId: "userId" in s.owner ? s.owner.userId : null,
        projectId: "projectId" in s.owner ? s.owner.projectId : null,
        name: skill.name,
        description: skill.description,
        source,
        files: skill.files,
        size: skill.size,
        enabled: true,
        createdBy: c.get("user").id,
        createdAt: now,
        updatedAt: now,
      };
      await writeFiles(c.env, id, files);
      await createDb(c.env.DB).insert(skills).values(row);
      return c.json({ skill: toSkill(row, true) }, 201);
    })
    .patch("/:skillId", async (c) => {
      const s = await scope(c);
      if (!s) return c.json({ error: "not_found" }, 404);
      const row = await findSkill(c.env, s.owner, c.req.param("skillId"));
      if (!row) return c.json({ error: "not_found" }, 404);
      if (!s.canEdit) return c.json({ error: "forbidden" }, 403);
      const input = UpdateSkillInput.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
      const { enabled, description, instructions } = input.data;
      const next: SkillRow = { ...row, ...(enabled !== undefined && { enabled }), updatedAt: new Date() };
      if (description !== undefined || instructions !== undefined) {
        if (row.source.kind !== "write") return c.json({ error: "invalid_input", message: "Only skills written here can be edited here." }, 400);
        const current = parseSkillMd(await readSkillMd(c.env, row.id));
        const md = formatSkillMd({ name: row.name, description: description ?? row.description, instructions: instructions ?? current.body });
        const result = checkSkillFiles(new Map([["SKILL.md", new TextEncoder().encode(md)]]));
        if (!result.ok) return c.json({ error: "invalid_skill", message: result.error }, 400);
        await writeFiles(c.env, row.id, new Map([["SKILL.md", new TextEncoder().encode(md)]]));
        Object.assign(next, { description: result.skill.description, files: result.skill.files, size: result.skill.size });
      }
      const { id: _, ...set } = next;
      await createDb(c.env.DB).update(skills).set(set).where(eq(skills.id, row.id));
      return c.json({ skill: toSkill(next, true) });
    })
    /** Takes a GitHub skill again from its branch or tag as it is now. */
    .post("/:skillId/update", async (c) => {
      const s = await scope(c);
      if (!s) return c.json({ error: "not_found" }, 404);
      const row = await findSkill(c.env, s.owner, c.req.param("skillId"));
      if (!row) return c.json({ error: "not_found" }, 404);
      if (!s.canEdit) return c.json({ error: "forbidden" }, 403);
      if (row.source.kind !== "github") return c.json({ error: "invalid_input", message: "Only skills from GitHub can be updated." }, 400);
      const [owner, repo] = row.source.repo.split("/") as [string, string];
      const prepared = await fromGithub({ owner, repo, path: row.source.path, ...(row.source.ref && { ref: row.source.ref }), skill: row.name });
      if (!prepared.ok) return c.json(prepared.body, prepared.status === 409 ? 502 : prepared.status);
      if (prepared.source.kind === "github" && prepared.source.commit === row.source.commit) {
        return c.json({ skill: toSkill(row, true), changed: false });
      }
      if (prepared.skill.name !== row.name && (await nameTaken(c.env, s.owner, prepared.skill.name, row.id))) {
        return c.json({ error: "name_taken", message: `There is already a skill named ${prepared.skill.name}.` }, 409);
      }
      const next: SkillRow = {
        ...row,
        name: prepared.skill.name,
        description: prepared.skill.description,
        source: prepared.source,
        files: prepared.skill.files,
        size: prepared.skill.size,
        updatedAt: new Date(),
      };
      await writeFiles(c.env, row.id, prepared.files);
      const { id: _, ...set } = next;
      await createDb(c.env.DB).update(skills).set(set).where(eq(skills.id, row.id));
      return c.json({ skill: toSkill(next, true), changed: true });
    })
    .delete("/:skillId", async (c) => {
      const s = await scope(c);
      if (!s) return c.json({ error: "not_found" }, 404);
      const row = await findSkill(c.env, s.owner, c.req.param("skillId"));
      if (!row) return c.json({ error: "not_found" }, 404);
      if (!s.canEdit) return c.json({ error: "forbidden" }, 403);
      await createDb(c.env.DB).delete(skills).where(eq(skills.id, row.id));
      await c.env.FILES.delete(bundleKey(row.id));
      return c.body(null, 204);
    });
}

/** Mounted at /api/account/skills: the signed-in person's own skills. */
export const accountSkillRoutes = skillRoutes(async (c) => ({ owner: { userId: c.get("user").id }, canEdit: true }));

/** Mounted at /api/projects/:id/skills. Members see them; owners and admins change them. */
export const projectSkillRoutes = skillRoutes(async (c) => {
  const projectId = c.req.param("id")!;
  const project = await findMembership(c.env, projectId, c.get("user").id);
  if (!project) return null;
  return { owner: { projectId }, canEdit: project.role === "owner" || project.role === "admin" };
});
