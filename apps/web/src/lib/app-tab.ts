/**
 * A browser tab the desktop or mobile app opened on this server's pages. The apps add ?app to such
 * links (the mobile app's in-app browser opens Devices, a project's GitHub tab, Skills and the legal
 * pages; a connector sign-in an app started comes back with it), and the mark stays with the tab
 * (sessionStorage) through signing in and GitHub's round trip. Such a tab shows no Plan and billing
 * and no way to buy: the store apps sell their plans only through in-app purchase (App Store
 * guideline 3.1.1). Other tabs, and the web app opened on its own, are not affected.
 */
const KEY = "myrel.fromApp";

/** Set for this page load once ?app was seen, for a browser that keeps no sessionStorage. */
let marked = false;

/** Notes ?app before the router can drop it from the address: main.tsx calls it before the router starts. */
export function markAppTab(): void {
  if (!new URLSearchParams(globalThis.location?.search ?? "").has("app")) return;
  marked = true;
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {
    // Storage off: this page load still counts.
  }
}

/** Whether an app opened this tab, so plans and purchases stay out of it. */
export function openedFromApp(): boolean {
  if (marked) return true;
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
