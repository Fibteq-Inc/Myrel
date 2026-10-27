import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { RunnerUpdateState } from "@myrel/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunnerConfig } from "../src/config";
import { applySettings, installBin, previousBin, readMarker, settingsOf, untarFile, updateMode, writeMarker } from "../src/self-update";
import { serviceBin } from "../src/service";
import { Updater, type UpdaterOptions } from "../src/updater";

let home: string;
const before = process.env.MYREL_RUNNER_HOME;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "myrel-update-"));
  process.env.MYREL_RUNNER_HOME = home;
  await mkdir(join(home, "bin"), { recursive: true });
});
afterEach(() => {
  if (before === undefined) delete process.env.MYREL_RUNNER_HOME;
  else process.env.MYREL_RUNNER_HOME = before;
});

const config = (extra: Partial<RunnerConfig> = {}): RunnerConfig => ({ folders: [], access: "edit", ...extra });

describe("settings", () => {
  it("shows defaults for a config that never set them", () => {
    expect(settingsOf(config())).toEqual({ access: "edit", worktrees: true, autoUpdate: false, remote: true });
  });

  it("changes only what Myrel sent", () => {
    const c = config({ worktrees: false });
    applySettings(c, { access: "full", autoUpdate: true });
    expect(settingsOf(c)).toEqual({ access: "full", worktrees: false, autoUpdate: true, remote: true });
  });

  it("refuses changes from Myrel when they are turned off on the computer", () => {
    const c = config({ remoteSettings: false });
    expect(() => applySettings(c, { access: "full" })).toThrow(/turned off on this computer/);
    expect(c.access).toBe("edit");
  });
});

describe("updateMode", () => {
  it("tells the background service's copy from a terminal one", () => {
    expect(updateMode(serviceBin())).toBe("service");
    expect(updateMode("/somewhere/else/cli.js")).toBe("manual");
  });
});

describe("untarFile", () => {
  it("finds the bundled CLI in an npm-style tarball", async () => {
    const dir = await mkdtemp(join(tmpdir(), "myrel-tar-"));
    await mkdir(join(dir, "package", "dist"), { recursive: true });
    await writeFile(join(dir, "package", "README.md"), "readme");
    await writeFile(join(dir, "package", "dist", "cli.js"), "console.log('hi')");
    const tgz = execFileSync("tar", ["-czf", "-", "-C", dir, "package"]);
    const tar = gunzipSync(tgz);
    expect(untarFile(tar, "package/dist/cli.js")?.toString()).toBe("console.log('hi')");
    expect(untarFile(tar, "package/dist/missing.js")).toBeNull();
  });
});

describe("installBin", () => {
  it("swaps in a version that starts and keeps the old one", async () => {
    await writeFile(serviceBin(), "console.log('0.12.1')");
    await installBin(Buffer.from("console.log('0.13.0')"), "0.13.0");
    expect(await readFile(serviceBin(), "utf8")).toContain("0.13.0");
    expect(await readFile(previousBin(), "utf8")).toContain("0.12.1");
  });

  it("leaves everything as it was when the new version does not start", async () => {
    await writeFile(serviceBin(), "console.log('0.12.1')");
    await expect(installBin(Buffer.from("throw new Error('broken')"), "0.13.0")).rejects.toThrow(/does not start/);
    expect(await readFile(serviceBin(), "utf8")).toContain("0.12.1");
  });
});

function updater(extra: Partial<UpdaterOptions> = {}) {
  const reports: (RunnerUpdateState | null)[] = [];
  let restarts = 0;
  let running: string[] = [];
  const u = new Updater({
    version: "0.13.0",
    running: () => running,
    report: (s) => reports.push(s),
    log: () => {},
    restart: () => restarts++,
    download: async () => Buffer.from("new"),
    install: async () => {},
    restore: async () => true,
    pollMs: 5,
    ...extra,
  });
  return {
    u,
    reports,
    restarts: () => restarts,
    setRunning: (r: string[]) => {
      running = r;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("Updater", () => {
  it("waits for running tasks, installs, marks the restart and restarts", async () => {
    const t = updater();
    t.setRunning(["task_1"]);
    expect(t.u.request("0.14.0").state).toBe("waiting");
    await settle();
    expect(t.restarts()).toBe(0);
    t.setRunning([]);
    await settle();
    expect(t.reports.map((r) => r?.state)).toEqual(["waiting", "downloading", "restarting"]);
    expect(t.restarts()).toBe(1);
    expect(await readMarker()).toMatchObject({ state: "restarting", version: "0.14.0", from: "0.13.0" });
  });

  it("does not wait with now", async () => {
    const t = updater();
    t.setRunning(["task_1"]);
    t.u.request("0.14.0", true);
    await settle();
    expect(t.restarts()).toBe(1);
  });

  it("auto-update waits longer for running tasks than a requested update", async () => {
    const t = updater({ latest: async () => "0.14.0", waitMs: 0, autoWaitMs: 60_000 });
    t.setRunning(["task_1"]);
    await t.u.checkNewest();
    await settle();
    expect(t.restarts()).toBe(0);
    expect(t.u.state()).toMatchObject({ state: "waiting", version: "0.14.0" });
    t.u.request("0.14.0");
    await settle();
    expect(t.restarts()).toBe(1);
  });

  it("refuses a version that is not newer", () => {
    expect(() => updater().u.request("0.13.0")).toThrow(/up to date/);
  });

  it("reports a failed download and keeps running", async () => {
    const t = updater({ download: async () => Promise.reject(new Error("npm is down")) });
    t.u.request("0.14.0");
    await settle();
    expect(t.restarts()).toBe(0);
    expect(t.u.state()).toMatchObject({ state: "failed", version: "0.14.0", message: "npm is down" });
  });

  it("confirms a new version once it connects", async () => {
    await writeMarker({ state: "restarting", version: "0.13.0", from: "0.12.1", at: new Date().toISOString() });
    const t = updater();
    expect(await t.u.init()).toBe(true);
    await t.u.confirmed();
    expect(t.u.confirming).toBe(false);
    expect(await readMarker()).toBeUndefined();
    expect(t.reports).toEqual([null]);
  });

  it("goes back to the previous version when the new one cannot connect, and the old one says so", async () => {
    await writeMarker({ state: "restarting", version: "0.13.0", from: "0.12.1", at: new Date().toISOString() });
    const t = updater();
    await t.u.init();
    await t.u.rollback("the server refused it");
    expect(t.restarts()).toBe(1);
    const old = updater({ version: "0.12.1" });
    expect(await old.u.init()).toBe(false);
    expect(old.u.state()).toMatchObject({ state: "rolled-back", version: "0.13.0", message: "the server refused it" });
  });

  it("auto-update skips a version that just failed", async () => {
    const t = updater({ latest: async () => "0.14.0", download: async () => Promise.reject(new Error("bad")) });
    await t.u.checkNewest();
    await settle();
    const count = t.reports.length;
    await t.u.checkNewest();
    await settle();
    expect(t.reports.length).toBe(count);
  });
});
