import { spawn } from "node:child_process";
import { isNewerRunner } from "@myrel/protocol";

export const PACKAGE_NAME = "@fibteq/myrel-runner";
/** The package name as the registry's URLs take it (scope slash encoded). */
export const PACKAGE_PATH = "@fibteq%2Fmyrel-runner";

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The version npm installs as latest, or null when npm cannot be reached. */
export async function latestVersion(registry = "https://registry.npmjs.org"): Promise<string | null> {
  try {
    const res = await fetch(`${registry}/${PACKAGE_PATH}/latest`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const { version } = (await res.json()) as { version?: unknown };
    // Only a plain version goes into the npx command line (a shell on Windows), whatever the registry sent.
    return typeof version === "string" && VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

/** Whether version `a` is newer than `b` (major.minor.patch; pre-release tags are ignored). */
export const isNewer = isNewerRunner;

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
      env: { ...process.env, MYREL_RUNNER_UPDATING: version },
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
