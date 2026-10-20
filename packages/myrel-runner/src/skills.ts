import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** Name of the plugin Claude Code gets the skills in, so they show as myrel:<name>. */
export const SKILLS_PLUGIN = "myrel";

/** Where a run's skills are: `plugin` is a Claude Code plugin folder whose `skills` folder holds them. */
export type RunSkills = { plugin: string; skills: string; count: number };

type Bundle = { skills: { name: string; files: { path: string; content: string }[] }[] };

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Downloads the turn's skills from the server (a SkillBundle, read with the run's token) into
 * `<dir>/plugin/skills/<name>/`, laid out as a Claude Code plugin. Other CLIs are told the folder.
 * Null when there are none or they cannot be fetched: the run goes on without them.
 */
export async function downloadSkills(url: string, token: string, dir: string, fetcher: typeof fetch = fetch): Promise<RunSkills | null> {
  let bundle: Bundle;
  try {
    const res = await fetcher(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    bundle = (await res.json()) as Bundle;
  } catch {
    return null;
  }
  const plugin = join(dir, "plugin");
  const skills = join(plugin, "skills");
  let count = 0;
  for (const skill of bundle.skills ?? []) {
    if (!NAME.test(skill.name)) continue;
    const root = join(skills, skill.name);
    for (const file of skill.files ?? []) {
      const target = resolve(root, file.path);
      // Never outside the skill's own folder, whatever the path says.
      if (!target.startsWith(root + sep)) continue;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.content, "base64"));
      if (/\.(sh|py)$/.test(file.path) || file.path.startsWith("scripts/")) await chmod(target, 0o755).catch(() => {});
    }
    count++;
  }
  if (!count) return null;
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: SKILLS_PLUGIN, description: "Skills added in Myrel for this run.", version: "1.0.0" }),
  );
  return { plugin, skills, count };
}
