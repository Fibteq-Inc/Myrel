// A legal page the mobile app opened (?app) marks its tab as the web app does (apps/web/src/lib/app-tab.ts):
// going on from here to the web app, that tab shows no Plan and billing and no way to buy (App Store guideline 3.1.1).
try {
  if (new URLSearchParams(location.search).has("app")) sessionStorage.setItem("myrel.fromApp", "1");
} catch {
  // Storage off: nothing to keep.
}
