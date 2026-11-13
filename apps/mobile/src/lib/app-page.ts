/**
 * A page of the server's site the in-app browser opens, marked ?app: a tab opened that way shows no
 * Plan and billing and no way to buy, however the person goes on from there (App Store guideline
 * 3.1.1: the app sells plans only through in-app purchase; see apps/web/src/lib/app-tab.ts and the
 * legal pages' legal.js). Every link from the app to the server's own pages goes through it.
 */
export function appPage(url: string): string {
  const hash = url.indexOf("#");
  const base = hash < 0 ? url : url.slice(0, hash);
  const fragment = hash < 0 ? "" : url.slice(hash);
  return `${base}${base.includes("?") ? "&" : "?"}app${fragment}`;
}
