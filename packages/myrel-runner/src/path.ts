import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/**
 * Folders that hold the CLIs people install, which a runner started at login, by a launcher or
 * before the install may not have on its PATH. On Windows the PATH the runner inherited is the one
 * Explorer had at login, so a CLI installed later, or one whose folder a shell profile adds (fnm,
 * a PowerShell profile), is not found; the PATH saved in the registry is read again each time.
 */
export async function refreshPath(): Promise<void> {
  const extra = [dirname(process.execPath), ...(process.platform === "win32" ? [...(await registryPath()), ...windowsBins()] : [])];
  process.env.PATH = mergePath(process.env.PATH ?? "", extra, delimiter, process.platform === "win32");
}

/**
 * `current` with the folders of `extra` it lacks added at the end, so the folders it already
 * had keep their order and win. Windows compares folders without case or a trailing slash.
 */
export function mergePath(current: string, extra: string[], sep = delimiter, ignoreCase = false): string {
  const key = (p: string) => {
    const k = p.trim().replace(/[\\/]+$/, "");
    return ignoreCase ? k.toLowerCase() : k;
  };
  const parts = current.split(sep).filter(Boolean);
  const seen = new Set(parts.map(key));
  for (const p of extra) {
    if (!p.trim() || seen.has(key(p))) continue;
    seen.add(key(p));
    parts.push(p.trim());
  }
  return parts.join(sep);
}

/** Expands `%NAME%` the way Windows does for a REG_EXPAND_SZ value; unknown names stay as they are. */
export function expandWindowsVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const vars = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => vars.get(name.toLowerCase()) ?? whole);
}

/** The Path value in `reg query` output, or undefined when it has none. */
export function parseRegPath(output: string): string | undefined {
  const line = output.split(/\r?\n/).find((l) => /^\s*Path\s+REG_(EXPAND_)?SZ\s/i.test(l));
  return line?.replace(/^\s*Path\s+REG_(EXPAND_)?SZ\s+/i, "").trim() || undefined;
}

const REGISTRY_KEYS = ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "HKCU\\Environment"];

/** The system and user PATH saved in the registry, as a new terminal would get it. */
async function registryPath(): Promise<string[]> {
  const values = await Promise.all(
    REGISTRY_KEYS.map(
      (key) =>
        new Promise<string | undefined>((resolve) => {
          execFile("reg", ["query", key, "/v", "Path"], { timeout: 5_000, windowsHide: true }, (err, stdout) => resolve(err ? undefined : parseRegPath(stdout)));
        }),
    ),
  );
  return values.flatMap((v) => (v ? expandWindowsVars(v).split(";") : []));
}

/** Where npm, pnpm, bun, Scoop, winget and native installers put CLIs on Windows, when they exist. */
function windowsBins(): string[] {
  const home = homedir();
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return [
    join(appData, "npm"),
    process.env.PNPM_HOME ?? join(local, "pnpm"),
    join(home, ".bun", "bin"),
    join(home, ".local", "bin"),
    join(home, "scoop", "shims"),
    join(local, "Microsoft", "WinGet", "Links"),
    join(local, "Volta", "bin"),
  ].filter((p) => existsSync(p));
}
