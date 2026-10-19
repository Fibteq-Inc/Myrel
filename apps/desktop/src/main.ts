import { handleDeepLinks } from "./deep-link";
import { desktopPlatform } from "./platform";
import { checkForUpdate } from "./updater";

// apps/web reads the platform when its modules load, so it must exist before the app is imported.
const platform = desktopPlatform();
(globalThis as { __ALTAIR_PLATFORM__?: typeof platform }).__ALTAIR_PLATFORM__ = platform;

await import("@altair/web/main");

void handleDeepLinks(platform);
if (!import.meta.env.DEV) void checkForUpdate();
