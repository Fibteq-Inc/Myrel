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
    // One box per line: the bounding box of text that wraps after other inline text (a bold
    // "Note:" then a long sentence) spans the whole first line and would overlap its neighbour.
    const lines = [...range.getClientRects()]
      .map((line) => visibleBox(el, line))
      .filter((r) => r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && area(r) > 4);
    if (lines.length && textRects.length < 600) textRects.push({ el, lines, text: t.nodeValue.trim().slice(0, 40) });
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
      const hit = a.lines.find((ra) => b.lines.some((rb) => {
        const shared = intersect(ra, rb);
        return shared && shared / Math.min(area(ra), area(rb)) > 0.25;
      }));
      if (hit) push(out.textOverlaps, { a: path(a.el), aText: a.text, b: path(b.el), bText: b.text, box: box(hit) });
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

/**
 * Text that tells people how to operate the screen ("Click the + button to add a task", "Bu
 * sayfada projelerinizi görebilirsiniz"), the usual sign of a screen that explains itself instead of
 * guiding by design. Runs inside the page like layoutChecks. English and Turkish phrases; the model
 * judges other languages from the screenshots (rubric.md).
 *
 * @param {{ ignore: string[], limit: number, pageCoords: boolean }} opts
 */
export function explainChecks(opts) {
  const { ignore, limit, pageCoords } = opts;
  const sx = pageCoords ? window.scrollX : 0;
  const sy = pageCoords ? window.scrollY : 0;
  const box = (r) => ({ x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) });
  const vh = window.innerHeight;
  const isIgnored = (el) => ignore.some((sel) => { try { return el.closest(sel); } catch { return false; } });
  const shown = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const hidden = (el) =>
    !!el.closest('[inert],[aria-hidden="true"]') ||
    (typeof el.checkVisibility === "function" && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
  // Prose people came to read (an article, docs, a code sample) may well say "click": not the app's own UI.
  const prose = 'article,[role="article"],pre,code,kbd,samp,blockquote,[class*="prose"],[class*="markdown"],[class*="docs"],[contenteditable="true"],textarea,[role="textbox"]';
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

  // How-to sentences: an action verb aimed at a control or a place on the screen, "this page lets
  // you", "here you can", numbered steps of clicks. \b is rewritten to a Unicode word boundary so
  // Turkish letters count as letters.
  const W = "[\\p{L}\\p{N}_]";
  const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
  const rx = (s) => new RegExp(s.replaceAll("\\b", B), "iu");
  const how = [
    String.raw`\b(click|tap|press|select|choose|drag|swipe|hover|double[- ]click|right[- ]click)(s|ing)?\b[^.!?\n]{0,50}\b(button|icon|link|menu|tab|toggle|switch|checkbox|field|here|below|above|left|right|top|bottom|corner|sidebar|toolbar)\b`,
    String.raw`\b(click|tap|press)\b[^.!?\n]{0,40}\bto (add|create|start|open|edit|delete|remove|save|see|view|change|upload|begin|continue|get started)\b`,
    String.raw`\b(here|on this (page|screen)|in this (section|panel|view|tab)) you('ll| will)? (can|may)\b`,
    String.raw`\bthis (page|screen|section|panel|dashboard|view|tab) (shows|lists|lets you|allows you|helps you|is where|displays|contains|gives you)\b`,
    String.raw`\b(use|using) the [^.!?\n]{0,40}\b(button|menu|tab|panel|sidebar|toolbar|field|form|filter|icon|search bar|dropdown|arrow|key)s? (to|on|above|below|at)\b`,
    String.raw`\bto (add|create|start|open|edit|delete|remove|save|see|view|change|upload|filter|sort|search|get started)\b[^.!?\n]{0,50}, (click|tap|press|select|choose|use|drag)\b`,
    String.raw`(düğme|buton|simge|ikon|bağlantı|menü|sekme|butona|linke)\p{L}*[^.!?\n]{0,30}(tıklayın|tıklayarak|tıklayınız|dokunun|dokunarak|basın|basarak)`,
    String.raw`\biçin\b[^.!?\n]{0,60}(tıklayın|tıklayınız|dokunun|basın|seçin|sürükleyin)`,
    String.raw`\b(simply|just) (click|tap|press|enter|drag|select|type|choose)\b`,
    String.raw`\b(first|then|next|finally|step \d+)[,:]? (click|tap|press|select|enter|type|choose|drag)\b`,
    String.raw`\bhow to use (this|the) (app|page|screen|tool|dashboard)\b`,
    String.raw`(tıkla|tıklay|tıklan|dokun|basın|basarak|basıp|seçerek|sürükle)[^.!?\n]{0,50}(düğme|buton|simge|ikon|bağlantı|menü|sekme|burada|buraya|aşağı|yukarı|sol|sağ|köşe|ekle|oluştur|başla|aç|düzenle|sil|kaydet|yükle)`,
    String.raw`\bbu (sayfa|ekran|bölüm|panel|alan|sekme)(da|de|dan|den|ya|ye)\b[^.!?\n]{0,80}(yapabilir|edebilir|görebilir|bulabilir|ulaşabilir|ekleyebilir|yönetebilir|izleyebilir|inceleyebilir)`,
    String.raw`\b(buradan|burada|bu alandan|bu ekrandan|bu sayfadan)\b[^.!?\n]{0,80}(yapabilir|edebilir|görebilir|ekleyebilir|yönetebilir|ulaşabilir)`,
    String.raw`(kullanarak|aracılığıyla|yardımıyla)[^.!?\n]{0,50}(yapabilir|edebilir|ekleyebilir|oluşturabilir|filtreleyebilir|arayabilir)`,
    String.raw`\b(önce|ardından|sonra|son olarak|adım \d+)[,:]? [^.!?\n]{0,30}(tıkla|seçin|girin|yazın|dokunun|basın)`,
    String.raw`\bnasıl kullanılır\b|\bkullanım (kılavuzu|talimat)`,
  ].map(rx);
  // The screen narrating its own layout: "the menu on the left", "soldaki menü".
  const where = [
    String.raw`\b(button|icon|menu|link|tab|panel|sidebar|toolbar|form|field|filter|search|list|bar|option|setting|control)s? (above|below|on the (left|right)|at the (top|bottom)|in the (top|bottom|upper|lower) (left|right|corner))\b`,
    String.raw`\b(sağ|sol) ?(üst|alt)(teki|taki|deki|daki)\b`,
    String.raw`\bthe (left|right|top|bottom|upper|lower)[- ](hand )?(menu|panel|sidebar|corner|toolbar|bar)\b`,
    String.raw`\b(yukarıdaki|aşağıdaki|soldaki|sağdaki|üstteki|alttaki|köşedeki) (düğme|buton|menü|simge|ikon|form|alan|sekme|bağlantı|panel)`,
    String.raw`\b(sol|sağ|üst|alt) (taraftaki|köşedeki|menüdeki|paneldeki)\b`,
  ].map(rx);
  // Boxes named for help that stay on screen ("hint", "tip", "instructions", "onboarding"), by a
  // class, id or test id; not utility classes such as cursor-help.
  const helpWord = /(^|[_-])(hint|help|helper|tip|tips|instruction|instructions|guide|howto|how-to|onboarding|explainer|walkthrough|tutorial)([_-]|$)/i;
  const helpBox = (n) =>
    [...n.classList, n.id, n.getAttribute("data-testid") ?? ""].some((w) => w && !/^cursor-|:/.test(w) && helpWord.test(w));

  const blocks = new Map();
  const blockOf = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const d = getComputedStyle(n).display;
      if (d !== "inline" && d !== "contents") return n;
    }
    return el;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) => (t.nodeValue.trim().length > 2 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const el = t.parentElement;
    if (!el || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "OPTION"].includes(el.tagName) || el.closest(prose) || isIgnored(el) || !shown(el) || hidden(el)) continue;
    const b = blockOf(el);
    if (!blocks.has(b)) blocks.set(b, b.innerText.replace(/\s+/g, " ").trim());
  }

  const found = [];
  for (const [el, text] of blocks) {
    const count = text.split(" ").filter(Boolean).length;
    if (count > 400) continue;
    const sentence = (re) => {
      const m = re.exec(text);
      if (!m) return null;
      // The sentence it is in (innerText's line breaks are already spaces).
      const dot = Math.max(text.lastIndexOf(". ", m.index), text.lastIndexOf("! ", m.index), text.lastIndexOf("? ", m.index));
      const from = dot < 0 ? 0 : dot + 2;
      return text.slice(from, from + 160);
    };
    let kind = null;
    let quote = null;
    for (const [k, list] of [["layout", where], ["how-to", how]]) {
      for (const re of list) if (!quote) quote = sentence(re);
      if (quote) { kind = k; break; }
    }
    let at = el;
    if (!kind && count >= 15) {
      // The block or one of its three nearest boxes; a page-wide wrapper named "guide" is not a help box.
      let n = el;
      for (let up = 0; n && n !== document.body && up < 4; n = n.parentElement, up++) {
        if (helpBox(n)) { kind = "help-box"; at = n; quote = text.slice(0, 160); break; }
      }
    }
    if (!kind) continue;
    const r = at.getBoundingClientRect();
    if (!pageCoords && (r.bottom <= 0 || r.top >= vh)) continue;
    found.push({ el: at, kind, quote, count, r });
  }
  // A block holding a found one says the same thing again: keep the innermost.
  const items = found
    .filter((f) => !found.some((o) => o !== f && f.el !== o.el && f.el.contains(o.el)))
    .filter((f, i, all) => all.findIndex((o) => o.el === f.el) === i)
    .slice(0, limit)
    .map((f) => ({ kind: f.kind, target: path(f.el), text: f.quote, words: f.count, box: box(f.r) }));
  return { items };
}
