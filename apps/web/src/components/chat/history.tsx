import { useT } from "@myrel/i18n/react";
import { ChevronUp } from "lucide-react";
import { type MouseEvent, useLayoutEffect, useRef, useState } from "react";

/** Messages drawn when a conversation opens; earlier ones come in pages of this size. */
export const HISTORY_PAGE = 60;

/**
 * The newest part of a long conversation. Drawing every message of a long
 * chat at once is what makes it slow to open and to update, so only the last
 * page is drawn until the reader asks for more.
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
    showEarlier: (e: MouseEvent<HTMLElement>) => {
      const el = scrollParent(e.currentTarget);
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

/** The button at the top of a long conversation that draws the page before it. */
export function EarlierMessages({ hidden, onShow }: { hidden: number; onShow: (e: MouseEvent<HTMLElement>) => void }) {
  const t = useT();
  if (!hidden) return null;
  return (
    <button
      type="button"
      onClick={onShow}
      className="mx-auto flex h-8 items-center gap-1.5 rounded-full border border-line bg-raised px-3 text-xs text-muted transition-colors hover:border-edge hover:text-fg"
    >
      <ChevronUp size={14} aria-hidden="true" />
      {t("chat.earlier", { count: hidden })}
    </button>
  );
}
