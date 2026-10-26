import { useT } from "@myrel/i18n/react";
import { ChevronUp } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Messages drawn when a conversation opens; earlier ones come in pages of this size. */
export const HISTORY_PAGE = 60;

/** How close to the top (in px) the reader scrolls before the page above is drawn. */
const NEAR_TOP = 600;

/**
 * The newest part of a long conversation. Drawing every message of a long
 * chat at once is what makes it slow to open and to update, so only the last
 * page is drawn; scrolling up draws the page before it.
 */
export function useHistoryWindow<T>(items: T[], page = HISTORY_PAGE) {
  const [shown, setShown] = useState(page);
  const keep = useRef<{ el: HTMLElement; fromBottom: number } | null>(null);
  // The page drawn above keeps the message the reader was looking at in place.
  useLayoutEffect(() => {
    const k = keep.current;
    keep.current = null;
    if (k) k.el.scrollTop = k.el.scrollHeight - k.fromBottom;
  }, [shown]);
  const hidden = Math.max(0, items.length - shown);
  return {
    visible: hidden ? items.slice(hidden) : items,
    hidden,
    /** Draws the page above; `from` is an element inside the scroll area. */
    showEarlier: (from: HTMLElement) => {
      const el = scrollParent(from);
      if (el) keep.current = { el, fromBottom: el.scrollHeight - el.scrollTop };
      setShown((n) => n + page);
    },
  };
}

function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
  }
  return null;
}

/**
 * The top of a long conversation: the page before it is drawn once the reader
 * scrolls near it, and the button does the same for a click or the keyboard.
 */
export function EarlierMessages({ hidden, onShow }: { hidden: number; onShow: (from: HTMLElement) => void }) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const show = useRef(onShow);
  show.current = onShow;
  // Observed again after each page, so a page that still leaves the top in view draws the next one.
  useEffect(() => {
    const button = ref.current;
    if (!button || !hidden || typeof IntersectionObserver === "undefined") return;
    const root = scrollParent(button);
    // The first check comes after the scroll area was brought to its end, so opening draws one page;
    // a page too short to fill the area draws the next one.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) show.current(button);
      },
      { root, rootMargin: `${NEAR_TOP}px 0px 0px 0px` },
    );
    observer.observe(button);
    return () => observer.disconnect();
  }, [hidden]);
  if (!hidden) return null;
  return (
    <button
      ref={ref}
      type="button"
      onClick={(e) => onShow(e.currentTarget)}
      className="mx-auto flex h-8 items-center gap-1.5 rounded-full border border-line bg-raised px-3 text-xs text-muted transition-colors hover:border-edge hover:text-fg"
    >
      <ChevronUp size={14} aria-hidden="true" />
      {t("chat.earlier", { count: hidden })}
    </button>
  );
}
