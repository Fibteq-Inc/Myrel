// Finds Playwright and axe-core for the checks. They are pinned and kept in a cache folder outside
// the project being checked, so every project is captured by the same browser (screenshots from
// different Chromium builds differ) and nothing is added to the project's own dependencies.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PLAYWRIGHT_VERSION = "1.64.1";
export const AXE_VERSION = "4.14.0";

const cacheRoot = () =>
  process.env.MYREL_CHECKS_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "myrel-visual-check");

/** The cache folder for this pair of versions, installed with npm on first use. */
async function depsDir(log) {
  const dir = join(cacheRoot(), `pw-${PLAYWRIGHT_VERSION}-axe-${AXE_VERSION}`);
  if (existsSync(join(dir, "node_modules", "playwright", "package.json")) && existsSync(join(dir, "node_modules", "axe-core", "axe.min.js"))) {
    return dir;
  }
  log(`Installing playwright@${PLAYWRIGHT_VERSION} and axe-core@${AXE_VERSION} into ${dir} (first run only)`);
  // Install next to it and rename, so two checks starting at once never see half a folder.
  const tmp = `${dir}.tmp-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await writeFile(join(tmp, "package.json"), JSON.stringify({ private: true, name: "myrel-visual-check-deps" }));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(
    npm,
    ["install", "--no-audit", "--no-fund", "--loglevel=error", "--save-exact", `playwright@${PLAYWRIGHT_VERSION}`, `axe-core@${AXE_VERSION}`],
    { cwd: tmp, stdio: ["ignore", "inherit", "inherit"], shell: process.platform === "win32" },
  );
  await mkdir(dirname(dir), { recursive: true });
  try {
    await rename(tmp, dir);
  } catch {
    // Another check got there first.
    await rm(tmp, { recursive: true, force: true });
  }
  return dir;
}

/** Playwright's chromium (and its Electron driver) and the axe-core source, ready to use. */
export async function loadDeps(log = (m) => console.error(m)) {
  const dir = await depsDir(log);
  const require = createRequire(join(dir, "package.json"));
  const playwright = require("playwright");
  const axeSource = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  return { chromium: playwright.chromium, electron: playwright._electron, axeSource, playwrightCli: cli };
}

/**
 * Launches Chromium, downloading it once when it is missing. A computer without the browser's
 * system libraries gets the one command that installs them (it needs sudo, so it is the person's step).
 */
export async function launchBrowser(deps, log = (m) => console.error(m)) {
  const launch = () => deps.chromium.launch({ args: ["--force-color-profile=srgb", "--font-render-hinting=none"] });
  try {
    return await launch();
  } catch (err) {
    const text = String(err?.message ?? err);
    if (/Executable doesn't exist|please run the following command to download new browsers/i.test(text)) {
      log("Downloading Chromium for Playwright (first run only)");
      execFileSync(process.execPath, [deps.playwrightCli, "install", "chromium"], { stdio: ["ignore", "inherit", "inherit"] });
      return await launch();
    }
    if (/missing dependencies|error while loading shared libraries/i.test(text)) {
      throw new Error(
        `Chromium cannot start: this computer lacks its system libraries. Someone with sudo runs once:\n  sudo npx playwright@${PLAYWRIGHT_VERSION} install-deps chromium\n\n${text.slice(0, 600)}`,
      );
    }
    throw err;
  }
}
