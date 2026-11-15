// A docs tab the mobile app opened (?app): links on to the hosted Myrel app carry ?app too, so that
// tab shows no Plan and billing and no way to buy there (App Store guideline 3.1.1; see
// apps/web/src/lib/app-tab.ts). The mark stays with the tab while the person reads on.
(() => {
  const KEY = "myrel.fromApp";
  let app = new URLSearchParams(location.search).has("app");
  try {
    if (app) sessionStorage.setItem(KEY, "1");
    else app = sessionStorage.getItem(KEY) === "1";
  } catch {
    // Storage off: only this page counts.
  }
  if (!app) return;
  const mark = (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || link.hostname !== "myrel.fibteq.io") return;
    const url = new URL(link.href);
    if (url.searchParams.has("app")) return;
    link.href = `${url.origin}${url.pathname}${url.search ? `${url.search}&` : "?"}app${url.hash}`;
  };
  // Before the link is followed, however it is opened.
  document.addEventListener("click", mark, true);
  document.addEventListener("auxclick", mark, true);
})();
