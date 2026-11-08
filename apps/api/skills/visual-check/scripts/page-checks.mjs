// Layout checks that run inside the page (page.evaluate serializes the function, so it must not
// use anything from outside it). They read the boxes the browser laid out, not the source, so they
// work the same for any framework.

/**
 * @param {{ touch: boolean, ignore: string[], limit: number, minTarget: number }} opts
 */
export function layoutChecks(opts) {
  const { touch, ignore, limit, minTarget, pageCoords } = opts;
  // Where an element is in the screenshot, so a finding can be marked on it: the viewport's
  // coordinates, or the page's for a full-page screenshot.
  const sx = pageCoords ? window.scrollX : 0;
  const sy = pageCoords ? window.scrollY : 0;
  const box = (r) => ({ x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) });
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const vh = window.innerHeight;
  const out = { viewport: { width: vw, height: vh }, overflowX: null, offscreen: [], covered: [], overlaps: [], clipped: [], textOverlaps: [], smallTargets: [], cutControls: [], interactive: 0 };

  const isIgnored = (el) => ignore.some((sel) => { try { return el.closest(sel); } catch { return false; } });
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      let part = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(`${part}#${n.id}`); break; }
      const cls = [...n.classList].filter((c) => c.length < 30).slice(0, 2);
      if (cls.length) part += `.${cls.join(".")}`;
      parts.unshift(part);
      if (n === document.body) break;
    }
    return parts.join(" > ");
  };
  const label = (el) => (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || el.getAttribute("placeholder") || el.value || "").trim().replace(/\s+/g, " ").slice(0, 60);
  const shown = (el) => {
    if (!el.isConnected) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const hiddenByAncestor = (el) =>
    !!el.closest('[inert],[aria-hidden="true"]') ||
    (typeof el.checkVisibility === "function" && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
  const layer = (el) => el.closest('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="tooltip"],[role="menu"],[role="listbox"],[popover]');
  const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
  const intersect = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  };
  const clipsX = (s) => s.overflowX !== "visible";
  // The part of a box its overflow-hiding ancestors actually show: truncated text and content
  // scrolled half out of its container are measured by what is visible.
  const visibleBox = (el, r) => {
    let { left, top, right, bottom } = r;
    for (let a = el; a && a !== document.body && a !== doc; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const b = a.getBoundingClientRect();
      if (s.overflowX !== "visible") { left = Math.max(left, b.left); right = Math.min(right, b.right); }
      if (s.overflowY !== "visible") { top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); }
    }
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  };
  const scrollerY = (el) => {
    for (let a = el.parentElement; a && a !== document.body && a !== doc; a = a.parentElement) {
      const s = getComputedStyle(a);
      if ((s.overflowY === "auto" || s.overflowY === "scroll") && a.scrollHeight > a.clientHeight + 1) return a;
    }
    return doc.scrollHeight > vh + 1 ? doc : null;
  };
  const pinned = (el) => {
    for (let a = el; a && a !== doc; a = a.parentElement) {
      const p = getComputedStyle(a).position;
      if (p === "fixed" || p === "sticky") return true;
    }
    return false;
  };
  // Content passing under a sticky header, a floating composer or a bottom bar is normal: it
  // scrolls out from under it. True when el is in a vertical scroller that `over` is not part of.
  const scrollsUnder = (el, over) => {
    const sc = scrollerY(el);
    if (!sc) return false;
    if (sc === doc) return pinned(over) && !pinned(el);
    return !sc.contains(over);
  };
  const push = (list, item) => { if (list.length < limit) list.push(item); };

  // 1. The page scrolls sideways, and which elements stick out past the edge.
  if (doc.scrollWidth > vw + 1) out.overflowX = { scrollWidth: doc.scrollWidth, viewport: vw };
  const sticking = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
    const r = el.getBoundingClientRect();
    // Only elements straddling an edge: wholly outside is the usual hidden drawer or carousel slide.
    const straddles = (r.left < vw - 1 && r.right > vw + 1) || (r.left < -1 && r.right > 1);
    if (!straddles || isIgnored(el) || !shown(el) || hiddenByAncestor(el)) continue;
    let clipped = false;
    for (let a = el.parentElement; a && a !== document.body && a !== doc; a = a.parentElement) {
      if (clipsX(getComputedStyle(a))) { clipped = true; break; }
    }
    if (!clipped) sticking.push(el);
  }
  // The outermost ones are usually the cause (a fixed width); their children only follow.
  for (const el of sticking) {
    if (sticking.some((o) => o !== el && o.contains(el))) continue;
    const r = el.getBoundingClientRect();
    push(out.offscreen, { target: path(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), box: box(r) });
  }

  // 2. Controls another element sits on top of, so a tap lands on the wrong thing.
  const interactive = [...document.querySelectorAll('a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"],[role="radio"],[tabindex]:not([tabindex="-1"])')]
    .filter((el) => !isIgnored(el) && shown(el) && !hiddenByAncestor(el));
  out.interactive = interactive.length;

  // Controls cut by the screen edge inside a box that hides its overflow: the page does not scroll
  // sideways, so the part past the edge cannot be reached (a header row too wide for a phone).
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= vh) continue;
    const straddles = (r.left < vw - 1 && r.right > vw + 1) || (r.left < -1 && r.right > 1);
    if (!straddles) continue;
    let hiddenBy = null;
    for (let a = el.parentElement; a && a !== doc; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if (ox === "auto" || ox === "scroll") { hiddenBy = null; break; } // Scrolls: reachable.
      if (ox === "hidden" || ox === "clip") { hiddenBy = a; break; }
    }
    if (!hiddenBy) continue;
    const seen = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    push(out.cutControls, { target: path(el), text: label(el), visiblePx: Math.round(seen), width: Math.round(r.width), clippedBy: path(hiddenBy), box: box(r) });
  }
  const inView = [];
  for (const el of interactive) {
    const full = el.getBoundingClientRect();
    const r = visibleBox(el, full);
    const x0 = Math.max(r.left, 0), x1 = Math.min(r.right, vw), y0 = Math.max(r.top, 0), y1 = Math.min(r.bottom, vh);
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    inView.push({ el, r, full });
    if (getComputedStyle(el).pointerEvents === "none") continue;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
    const lab = hit.closest("label");
    if (lab && (lab.contains(el) || (el.id && lab.htmlFor === el.id))) continue;
    const top = layer(hit);
    if (top && !top.contains(el)) continue; // An open dialog or menu covers the page on purpose.
    if (scrollsUnder(el, hit)) continue;
    push(out.covered, { target: path(el), text: label(el), coveredBy: path(hit), box: box(r) });
  }

  // 3. Two controls overlapping each other.
  const n = Math.min(inView.length, 400);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = inView[i], b = inView[j];
      if (a.el.contains(b.el) || b.el.contains(a.el) || scrollsUnder(a.el, b.el) || scrollsUnder(b.el, a.el)) continue;
      const shared = intersect(a.r, b.r);
      if (shared && shared / Math.min(area(a.r), area(b.r)) > 0.3) {
        push(out.overlaps, { a: path(a.el), aText: label(a.el), b: path(b.el), bText: label(b.el), box: box(a.r) });
      }
    }
  }

  // 4. Text cut off by its box (an ellipsis or line clamp is deliberate and left alone).
  const textEls = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) => (t.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const textRects = [];
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const el = t.parentElement;
    if (!el || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName) || isIgnored(el) || !shown(el) || hiddenByAncestor(el)) continue;
    textEls.add(el);
    const range = document.createRange();
    range.selectNodeContents(t);
    const r = visibleBox(el, range.getBoundingClientRect());
    if (r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && area(r) > 4 && textRects.length < 600) textRects.push({ el, r, text: t.nodeValue.trim().slice(0, 40) });
  }
  for (const el of textEls) {
    const s = getComputedStyle(el);
    // Only hidden/clip cut text off; auto and scroll let it be scrolled to.
    const cuts = (v) => v === "hidden" || v === "clip";
    const cutX = cuts(s.overflowX) && s.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 1;
    const clamp = s.webkitLineClamp && s.webkitLineClamp !== "none";
    const cutY = cuts(s.overflowY) && !clamp && el.scrollHeight > el.clientHeight + 2;
    if (cutX || cutY) push(out.clipped, { target: path(el), text: label(el), axis: cutX ? "x" : "y", box: box(el.getBoundingClientRect()) });
  }

  // 5. Text drawn over other text.
  for (let i = 0; i < textRects.length; i++) {
    for (let j = i + 1; j < textRects.length; j++) {
      const a = textRects[i], b = textRects[j];
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el) || scrollsUnder(a.el, b.el) || scrollsUnder(b.el, a.el)) continue;
      const shared = intersect(a.r, b.r);
      if (shared && shared / Math.min(area(a.r), area(b.r)) > 0.25) {
        push(out.textOverlaps, { a: path(a.el), aText: a.text, b: path(b.el), bText: b.text, box: box(a.r) });
      }
    }
  }

  // 6. Tap targets too small for a finger (inline links in running text are exempt, as in WCAG 2.5.8).
  if (touch) {
    // The whole box, not the visible part: a button half scrolled out of view is not small.
    for (const { el, full: r } of inView) {
      if (getComputedStyle(el).display === "inline") continue;
      if (r.width < minTarget || r.height < minTarget) push(out.smallTargets, { target: path(el), text: label(el), width: Math.round(r.width), height: Math.round(r.height), box: box(r) });
    }
  }

  // What is on screen at all, so a blank screenshot can be told from a sparse page.
  out.visibleText = textRects.length;
  out.media = [...document.querySelectorAll("canvas,img,svg,video,iframe")].filter((el) => {
    if (!shown(el)) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && r.width * r.height > 400;
  }).length;

  // Images and fonts that did not load.
  out.brokenImages = [...document.images].filter((img) => img.complete && img.naturalWidth === 0 && img.currentSrc && shown(img)).slice(0, limit).map((img) => ({ target: path(img), src: img.currentSrc.slice(0, 200), box: box(img.getBoundingClientRect()) }));
  out.failedFonts = document.fonts ? [...document.fonts].filter((f) => f.status === "error").slice(0, limit).map((f) => f.family) : [];
  return out;
}
