import { useT } from "@myrel/i18n/react";
import { ArrowDown } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

/** How far from the end (in px) the reader has to be before the "jump to latest" button shows. */
const AWAY = 400;

/**
 * A scroll area that follows new content while the reader is at the bottom.
 * It follows what is at the end (the last message, and whether someone is thinking), not how much there is:
 * a reply and the end of "Thinking" often arrive in the same batch, and a count would stay the same.
 * A message the reader just sent (`mine`) brings them to the end even when they had scrolled up.
 * Far from the end, a button takes the reader back down in one tap.
 */
export function ScrollToEnd({
  last,
  busy,
  mine,
  className,
  children,
}: {
  last: string | undefined;
  busy: boolean;
  mine: boolean;
  className: string;
  children: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const seen = useRef(last);
  useEffect(() => {
    const el = ref.current;
    const sent = mine && last !== seen.current;
    seen.current = last;
    if (el && (pinned.current || sent)) el.scrollTop = el.scrollHeight;
    // `mine` describes `last`, so it changes with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last, busy]);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={ref}
        className={className}
        onScroll={(e) => {
          const el = e.currentTarget;
          const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
          // Keep following new messages only while the reader is at the bottom.
          pinned.current = fromEnd < 80;
          setAway(fromEnd > AWAY);
        }}
      >
        {children}
      </div>
      {away && (
        <button
          type="button"
          aria-label={t("chat.toEnd")}
          title={t("chat.toEnd")}
          onClick={() => {
            const el = ref.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
          className="absolute bottom-3 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-raised text-muted shadow-lg transition-colors hover:border-edge hover:text-fg"
        >
          <ArrowDown size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
