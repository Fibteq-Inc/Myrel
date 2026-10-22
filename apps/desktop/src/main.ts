import { openLinksExternally } from "@myrel/client";
import { handleDeepLinks } from "./deep-link";
import { desktopPlatform } from "./platform";
import { startUpdateChecks } from "./updater";

// apps/web reads the platform when its modules load, so it must exist before the app is imported.
const platform = desktopPlatform();
(globalThis as { __MYREL_PLATFORM__?: typeof platform }).__MYREL_PLATFORM__ = platform;
// The webview ignores target="_blank" and window.open; links to other sites go to the default browser.
// Must run before the plugins' injected link handlers (see openLinksExternally).
openLinksExternally(window, platform.openExternal);

await import("@myrel/web/main");

void handleDeepLinks(platform);
if (!import.meta.env.DEV) startUpdateChecks();
