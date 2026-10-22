import { type ReactNode, useEffect, useRef } from "react";

/**
 * A scroll area that follows new content while the reader is at the bottom.
 * It follows what is at the end (the last message, and whether someone is thinking), not how much there is:
 * a reply and the end of "Thinking" often arrive in the same batch, and a count would stay the same.
 * A message the reader just sent (`mine`) brings them to the end even when they had scrolled up.
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
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
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
    <div
      ref={ref}
      className={className}
      onScroll={(e) => {
        const el = e.currentTarget;
        // Keep following new messages only while the reader is at the bottom.
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {children}
    </div>
  );
}
