import type { AppUpdate, AppUpdater } from "@myrel/client";
import { getVersion } from "@tauri-apps/api/app";
import { ask } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

// The app often stays open for days, so it checks again while running, not only at startup.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The app's version and updates, from the release's latest.json (tauri.conf.json → plugins.updater). */
export function desktopUpdater(): AppUpdater {
  return {
    version: getVersion,
    async check(): Promise<AppUpdate | null> {
      const update = await check();
      if (!update) return null;
      return {
        version: update.version,
        async install() {
          await update.downloadAndInstall();
          await relaunch();
        },
      };
    },
  };
}

let checking = false;
// A version the person put off with "Later" isn't offered again until the app restarts.
let postponed: string | undefined;

/** Checks for a new release now and every few hours, and offers to install it. Silent when offline or unconfigured. */
export function startUpdateChecks(updater: AppUpdater) {
  const run = () => void checkForUpdate(updater);
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}

async function checkForUpdate(updater: AppUpdater) {
  if (checking) return;
  checking = true;
  try {
    const update = await updater.check();
    if (!update || update.version === postponed) return;
    const yes = await ask(`Myrel ${update.version} is available. Install it now and restart?`, {
      title: "Update available",
      okLabel: "Update",
      cancelLabel: "Later",
    });
    if (!yes) {
      postponed = update.version;
      return;
    }
    await update.install();
  } catch (err) {
    console.warn("Update check failed", err);
  } finally {
    checking = false;
  }
}
