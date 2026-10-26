import { useT } from "@myrel/i18n/react";
import { ChevronUp, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Messages drawn when a conversation opens; earlier ones come in pages of this size. */
export const HISTORY_PAGE = 60;

/** How close to the top (in px) the reader scrolls before the page above is drawn. */
const NEAR_TOP = 600;

/** Older messages of a conversation that are still on the server, and how to fetch the page before those held. */
export type EarlierOnServer = { hasEarlier: boolean; load: () => Promise<void> };

/**
 * The newest part of a long conversation. Drawing every message of a long
 * chat at once is what makes it slow to open and to update, so only the last
 * page is drawn; scrolling up draws the page before it, fetching it from the
 * server once the messages held run out. The oldest message drawn stays drawn
 * as new ones arrive, so nothing moves under a reader who scrolled up.
 */
export function useHistoryWindow<T extends { id: string }>(items: T[], earlier?: EarlierOnServer, page = HISTORY_PAGE) {
  // The window starts at `extra` messages before the anchor (the oldest message drawn when it opened).
  const [anchor, setAnchor] = useState<string | null>(null);
  const [extra, setExtra] = useState(0);
  const [loading, setLoading] = useState(false);
  const keep = useRef<{ el: HTMLElement; fromBottom: number } | null>(null);
  const at = anchor === null ? -1 : items.findIndex((m) => m.id === anchor);
  const start = at < 0 ? Math.max(0, items.length - page) : Math.max(0, at - extra);
  // Anchor the window once there are messages (and again when they change to another conversation's).
  useEffect(() => {
    if (at < 0 && items.length > 0) {
      setAnchor(items[start]!.id);
      setExtra(0);
    }
  }, [at, items, start]);
  // The page drawn above keeps the message the reader was looking at in place.
  useLayoutEffect(() => {
    const k = keep.current;
    keep.current = null;
    if (k) k.el.scrollTop = k.el.scrollHeight - k.fromBottom;
  }, [extra]);
  const hold = (from: HTMLElement) => {
    const el = scrollParent(from);
    if (el) keep.current = { el, fromBottom: el.scrollHeight - el.scrollTop };
  };
  return {
    visible: start ? items.slice(start) : items,
    hidden: start,
    /** Something is above what is drawn: held here or still on the server. */
    more: start > 0 || !!earlier?.hasEarlier,
    loading,
    /** Draws the page above; `from` is an element inside the scroll area. */
    showEarlier: (from: HTMLElement) => {
      if (loading) return;
      if (start > 0 || !earlier?.hasEarlier) {
        hold(from);
        setExtra((n) => n + page);
        return;
      }
      // Everything held is drawn: anchor at the oldest, then widen by the page fetched above it.
      if (items.length) setAnchor(items[0]!.id);
      setExtra(0);
      setLoading(true);
      earlier
        .load()
        .then(() => {
          // Measured right before the fetched page is drawn, in the same render as the wider window.
          hold(from);
          setExtra(page);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
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
export function EarlierMessages({
  hidden,
  more,
  loading = false,
  onShow,
}: {
  /** Earlier messages held but not drawn; 0 when the rest are still on the server. */
  hidden: number;
  more: boolean;
  loading?: boolean;
  onShow: (from: HTMLElement) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const show = useRef(onShow);
  show.current = onShow;
  // Observed again after each page, so a page that still leaves the top in view draws the next one.
  useEffect(() => {
    const button = ref.current;
    if (!button || !more || loading || typeof IntersectionObserver === "undefined") return;
    // The first check comes after the scroll area was brought to its end, so opening draws one page;
    // a page too short to fill the area draws the next one.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) show.current(button);
      },
      { root: scrollParent(button), rootMargin: `${NEAR_TOP}px 0px 0px 0px` },
    );
    observer.observe(button);
    return () => observer.disconnect();
  }, [more, hidden, loading]);
  if (!more) return null;
  return (
    <button
      ref={ref}
      type="button"
      disabled={loading}
      onClick={(e) => onShow(e.currentTarget)}
      className="mx-auto flex h-8 items-center gap-1.5 rounded-full border border-line bg-raised px-3 text-xs text-muted transition-colors hover:border-edge hover:text-fg disabled:opacity-70"
    >
      {loading ? (
        <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
      ) : (
        <ChevronUp size={14} aria-hidden="true" />
      )}
      {hidden ? t("chat.earlier", { count: hidden }) : t("chat.earlierMore")}
    </button>
  );
}
