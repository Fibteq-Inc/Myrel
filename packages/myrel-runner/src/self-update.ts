import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import type { RunnerSettings, RunnerSettingsInput, RunnerUpdates, RunnerUpdateState } from "@myrel/protocol";
import { readJson, type RunnerConfig, runnerHome, writeJson } from "./config";
import { serviceBin } from "./service";
import { PACKAGE_NAME } from "./update";

const run = promisify(execFile);

/** The runner's settings as Myrel shows them. */
export function settingsOf(config: RunnerConfig): RunnerSettings {
  return {
    access: config.access,
    worktrees: config.worktrees !== false,
    autoUpdate: config.autoUpdate === true,
    remote: config.remoteSettings !== false,
  };
}

/** Applies settings changed in Myrel. Refused when the person turned that off on this computer. */
export function applySettings(config: RunnerConfig, input: RunnerSettingsInput): void {
  if (config.remoteSettings === false) {
    throw new Error("Changing settings from Myrel is turned off on this computer. Turn it on there with `myrel-runner settings remote on`.");
  }
  if (input.access) config.access = input.access;
  if (input.worktrees !== undefined) config.worktrees = input.worktrees;
  if (input.autoUpdate !== undefined) config.autoUpdate = input.autoUpdate;
}

/**
 * How this runner can be updated: the background service runs the copy in ~/.myrel-runner/bin, the
 * desktop app runs a compiled one of its own, anything else was started in a terminal.
 */
export function updateMode(script = process.argv[1]): RunnerUpdates {
  if (process.versions.bun) return "app";
  return script && resolve(script) === serviceBin() ? "service" : "manual";
}

/** The previous version, kept to go back to when a new one does not come up. */
export const previousBin = () => join(runnerHome(), "bin", "myrel-runner.prev.mjs");

/** An update across a restart: what the next process checks when it starts. */
export type UpdateMarker = RunnerUpdateState & { from: string };

const markerPath = () => join(runnerHome(), "update.json");

export const readMarker = () => readJson<UpdateMarker>(markerPath()).catch(() => undefined);
export const writeMarker = (marker: UpdateMarker) => writeJson(markerPath(), marker);
export const clearMarker = () => rm(markerPath(), { force: true });

/** A failed update is shown this long, then forgotten. */
export const FAILED_SHOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Downloads `version` of myrel-runner from npm, checks it against the registry's integrity hash and
 * returns its bundled CLI (dist/cli.js), without running npm.
 */
export async function downloadRunner(version: string, registry = "https://registry.npmjs.org"): Promise<Buffer> {
  const meta = await fetch(`${registry}/${PACKAGE_NAME.replace("/", "%2F")}/${version}`, { signal: AbortSignal.timeout(30_000) });
  if (!meta.ok) throw new Error(`npm does not have myrel-runner ${version} (${meta.status}).`);
  const { dist } = (await meta.json()) as { dist?: { tarball?: string; integrity?: string } };
  const integrity = dist?.integrity?.match(/^sha512-([A-Za-z0-9+/=]+)$/)?.[1];
  if (!dist?.tarball || !integrity) throw new Error("npm sent no download for this version.");
  const res = await fetch(dist.tarball, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Could not download myrel-runner ${version} (${res.status}).`);
  const tarball = Buffer.from(await res.arrayBuffer());
  if (createHash("sha512").update(tarball).digest("base64") !== integrity) {
    throw new Error("The download does not match npm's checksum, so it was not installed.");
  }
  const cli = untarFile(gunzipSync(tarball), "package/dist/cli.js");
  if (!cli) throw new Error("The download has no dist/cli.js.");
  return cli;
}

/** One file out of a tar archive (ustar, with pax path headers), or null. */
export function untarFile(tar: Buffer, name: string): Buffer | null {
  let paxPath: string | undefined;
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) return null;
    const field = (start: number, length: number) => header.toString("utf8", start, start + length).replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      paxPath = body.toString("utf8").match(/^\d+ path=(.*)$/m)?.[1];
      continue;
    }
    const prefix = field(345, 155);
    const path = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    paxPath = undefined;
    if ((type === "0" || type === "") && path === name) return Buffer.from(body);
  }
  return null;
}

/**
 * Puts `cli` (a downloaded myrel-runner) in place of the background service's copy, after checking
 * that it starts and is `version`. The current copy is kept as the previous one.
 */
export async function installBin(cli: Buffer, version: string): Promise<void> {
  const bin = serviceBin();
  const next = join(runnerHome(), "bin", "myrel-runner.next.mjs");
  await writeFile(next, cli, { mode: 0o700 });
  try {
    const { stdout } = await run(process.execPath, [next, "--version"], { timeout: 30_000 });
    if (stdout.trim() !== version) throw new Error(`it says it is ${stdout.trim() || "nothing"}`);
  } catch (err) {
    await rm(next, { force: true });
    throw new Error(`The new version does not start (${(err as Error).message.split("\n")[0]}), so it was not installed.`);
  }
  if (await stat(bin).catch(() => null)) await copyFile(bin, previousBin());
  await rename(next, bin);
}

/** Puts the previous version back. False when there is none. */
export async function restorePrevious(): Promise<boolean> {
  if (!(await stat(previousBin()).catch(() => null))) return false;
  await copyFile(previousBin(), serviceBin());
  return true;
}
