/**
 * The URL to hand to the system browser for a link, or null when the app
 * should follow it itself (its own pages, `blob:` downloads and the like).
 */
export function externalUrl(href: string, appOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, appOrigin);
  } catch {
    return null;
  }
  if (url.protocol === "mailto:" || url.protocol === "tel:") return url.href;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin === appOrigin ? null : url.href;
}

type LinkWindow = Pick<Window, "location" | "open" | "addEventListener" | "removeEventListener">;

/**
 * Native shells (Tauri's WKWebView/WebView2) drop `target="_blank"` clicks and
 * `window.open` calls. Sends links to other sites through `open` (the system
 * browser) instead; the app's own links keep working as before.
 *
 * Listens on the window in the capture phase and stops the click there, so it runs
 * before the link handlers Tauri plugins inject: tauri-plugin-shell's calls
 * `shell.open`, which the app is not allowed to use, and cancels the click.
 * Returns a function that undoes it.
 */
export function openLinksExternally(win: LinkWindow, open: (url: string) => unknown): () => void {
  const appOrigin = win.location.origin;

  const onClick = (event: MouseEvent) => {
    // Middle clicks arrive as `auxclick`; right clicks open the context menu.
    if (event.defaultPrevented || event.button > 1) return;
    const target = event.target as Element | null;
    const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor || anchor.hasAttribute("download")) return;
    const url = externalUrl(anchor.getAttribute("href") ?? "", appOrigin);
    if (!url) return;
    event.preventDefault();
    event.stopPropagation();
    void open(url);
  };

  const windowOpen = win.open;
  const patchedOpen = ((href?: string | URL, ...rest: unknown[]) => {
    const url = href === undefined ? null : externalUrl(String(href), appOrigin);
    if (!url) return windowOpen.call(win, href, ...(rest as [string?, string?]));
    void open(url);
    return null;
  }) as Window["open"];

  win.addEventListener("click", onClick, true);
  win.addEventListener("auxclick", onClick, true);
  win.open = patchedOpen;
  return () => {
    win.removeEventListener("click", onClick, true);
    win.removeEventListener("auxclick", onClick, true);
    if (win.open === patchedOpen) win.open = windowOpen;
  };
}
