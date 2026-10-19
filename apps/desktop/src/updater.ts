import { ask } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

/** Checks for a new release once at startup and offers to install it. Silent when offline or unconfigured. */
export async function checkForUpdate() {
  try {
    const update = await check();
    if (!update) return;
    const yes = await ask(`Altair ${update.version} is available. Install it now and restart?`, {
      title: "Update available",
      okLabel: "Update",
      cancelLabel: "Later",
    });
    if (!yes) return;
    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    console.warn("Update check failed", err);
  }
}
