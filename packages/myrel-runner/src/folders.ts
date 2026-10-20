import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import type { RunnerDirListing } from "@altair/protocol";

const MAX_DIRS = 1000;

/**
 * The folders inside `path` (the home folder when absent), for the folder
 * picker in the web app. Only folder names are sent, never files or their
 * contents. Hidden folders are left out.
 */
export async function listDirs(path?: string): Promise<RunnerDirListing> {
  const home = homedir();
  const target = await realpath(path ? checkAbsolute(path) : home);
  const entries = await readdir(target, { withFileTypes: true });
  const dirs = entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: join(target, e.name) }));
  // Symlinks only count when they point at a folder.
  const real = await Promise.all(
    dirs.map(async (d) => ((await stat(d.path).catch(() => null))?.isDirectory() ? d : null)),
  );
  const listed = real.filter((d) => d !== null);
  listed.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const parent = dirname(target);
  return { path: target, parent: parent === target ? null : parent, home, dirs: listed.slice(0, MAX_DIRS) };
}

/**
 * Checks a folder the web app asked to share and returns its real path. The
 * filesystem root and the home folder itself are refused: a project should
 * get one project's folder, not the whole disk.
 */
export async function shareableFolder(path: string): Promise<string> {
  const real = await realpath(checkAbsolute(path)).catch(() => {
    throw new Error(`${path} does not exist on this computer.`);
  });
  if (!(await stat(real)).isDirectory()) throw new Error(`${path} is not a folder.`);
  if (real === parse(real).root || real === (await realpath(homedir()))) {
    throw new Error("Pick a project folder, not your whole home folder or disk.");
  }
  return real;
}

function checkAbsolute(path: string): string {
  if (!isAbsolute(path)) throw new Error(`${path} is not a full path.`);
  return path;
}
