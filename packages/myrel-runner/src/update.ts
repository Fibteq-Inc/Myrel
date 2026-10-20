import { spawn } from "node:child_process";

export const PACKAGE_NAME = "@fibteq/myrel-runner";

/** The version npm installs as latest, or null when npm cannot be reached. */
export async function latestVersion(registry = "https://registry.npmjs.org"): Promise<string | null> {
  try {
    const res = await fetch(`${registry}/${PACKAGE_NAME.replace("/", "%2F")}/latest`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const { version } = (await res.json()) as { version?: unknown };
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** Whether version `a` is newer than `b` (major.minor.patch; pre-release tags are ignored). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * Runs `myrel-runner <args>` from the given npm version, so the newest code
 * does the rest of the update. Resolves with its exit code.
 */
export function runVersion(version: string, args: string[]): Promise<number> {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return new Promise((resolve, reject) => {
    const child = spawn(npx, ["--yes", `--package=${PACKAGE_NAME}@${version}`, "--", "myrel-runner", ...args], {
      stdio: "inherit",
      shell: process.platform === "win32",
      // Tells the new version not to look for a newer one again.
      env: { ...process.env, ALTAIR_RUNNER_UPDATING: version },
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
