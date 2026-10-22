import { useT } from "@myrel/i18n/react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/**
 * Folds long content to `lines` lines (at 1.5 line height) behind a fading
 * edge and a "Show more" button, so one long message does not take over the
 * conversation. Content only a little over the limit (under `slack` times it)
 * stays open: folding away a line or two helps nobody.
 */
export function Collapsible({ lines, slack = 1.3, children }: { lines: number; slack?: number; children: ReactNode }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  const limit = lines * 1.5;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // scrollHeight is the content's full height even while folded.
    const measure = () => setLong(el.scrollHeight > parseFloat(getComputedStyle(el).fontSize) * limit * slack);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [limit, slack]);

  const folded = long && !open;
  return (
    <div>
      <div
        ref={ref}
        style={folded ? { maxHeight: `${limit}em` } : undefined}
        className={folded ? "overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]" : undefined}
      >
        {children}
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mt-1.5 text-[13px] font-medium text-accent hover:underline"
        >
          {open ? t("message.showLess") : t("message.showMore")}
        </button>
      )}
    </div>
  );
}
