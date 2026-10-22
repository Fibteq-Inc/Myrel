import { ask } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

// The app often stays open for days, so it checks again while running, not only at startup.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let checking = false;
// A version the person put off with "Later" isn't offered again until the app restarts.
let postponed: string | undefined;

/** Checks for a new release now and every few hours, and offers to install it. Silent when offline or unconfigured. */
export function startUpdateChecks() {
  void checkForUpdate();
  setInterval(() => void checkForUpdate(), CHECK_INTERVAL_MS);
}

async function checkForUpdate() {
  if (checking) return;
  checking = true;
  try {
    const update = await check();
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
    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    console.warn("Update check failed", err);
  } finally {
    checking = false;
  }
}
