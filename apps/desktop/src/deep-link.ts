import { normalizeServerUrl, probeServer, saveServer } from "@myrel/client";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { ask, message } from "@tauri-apps/plugin-dialog";
import type { Platform } from "@myrel/client";

/**
 * Handles `myrel://` links:
 * - `myrel://connect?server=https://myrel.example.com` switches to that server after asking.
 * - anything else opens the matching page, e.g. `myrel://projects/<id>` → `/projects/<id>`.
 */
export async function handleDeepLinks(platform: Platform) {
  const open = (urls: string[]) => {
    for (const url of urls) void openLink(platform, url);
  };
  open((await getCurrent()) ?? []);
  await onOpenUrl(open);
}

async function openLink(platform: Platform, raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== "myrel:") return;
  // `myrel://projects/1` parses with host "projects"; treat host and path as one route.
  const route = `/${[url.host, url.pathname.replace(/^\/+/, "")].filter(Boolean).join("/")}`;

  if (route === "/connect") {
    const target = url.searchParams.get("server");
    if (!target) return;
    try {
      const origin = normalizeServerUrl(target);
      await probeServer(origin);
      const yes = await ask(`Connect Myrel to ${new URL(origin).host}? Only continue if you trust this server.`, {
        title: "Switch server",
        kind: "warning",
      });
      if (!yes) return;
      await saveServer(platform.storage, origin);
      location.replace("/");
    } catch (err) {
      await message(err instanceof Error ? err.message : String(err), { title: "Could not connect", kind: "error" });
    }
    return;
  }

  // TanStack Router follows history changes, so a push plus popstate navigates without a reload.
  history.pushState(null, "", `${route}${url.search}${url.hash}`);
  dispatchEvent(new PopStateEvent("popstate"));
}
