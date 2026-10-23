import { type CSSProperties, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/ui";

/**
 * A button that opens a floating panel below it. The panel is rendered in a portal with fixed
 * positioning, so a card or list with overflow hidden cannot clip it; it opens upward when there
 * is no room below. Closes on outside click, Escape, scrolling, or when `children` calls `close`.
 */
export function Menu({
  trigger,
  label,
  align = "start",
  side = "bottom",
  className = "",
  panelClassName = "",
  children,
}: {
  trigger: ReactNode;
  label: string;
  align?: "start" | "end";
  side?: "bottom" | "top" | "right";
  className?: string;
  panelClassName?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // A fixed panel would drift from its button on scroll, so scrolling anything outside it closes it.
    const onScroll = (e: Event) => !panel.current?.contains(e.target as Node) && setOpen(false);
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    addEventListener("scroll", onScroll, true);
    addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      removeEventListener("scroll", onScroll, true);
      removeEventListener("resize", onResize);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !ref.current || !panel.current) return;
    const r = ref.current.getBoundingClientRect();
    const height = panel.current.offsetHeight;
    const gap = 6;
    const horizontal = align === "end" ? { right: Math.max(8, innerWidth - r.right) } : { left: Math.max(8, r.left) };
    if (side === "right") {
      setStyle({ left: r.right + 8, bottom: Math.max(8, innerHeight - r.bottom) });
      return;
    }
    // Open upward when asked to, or when there is no room below but there is above.
    const up = side === "top" || (r.bottom + gap + height > innerHeight - 8 && r.top - gap - height >= 8);
    setStyle(up ? { ...horizontal, bottom: innerHeight - r.top + gap } : { ...horizontal, top: r.bottom + gap });
  }, [open, align, side]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        className={className}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="menu"
            aria-label={label}
            style={style}
            className={cn(
              "fixed z-[100] min-w-56 rounded-xl border border-edge bg-menu p-1.5 shadow-[0_12px_40px_var(--color-shadow)]",
              panelClassName,
            )}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  onSelect,
  className = "",
}: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-body hover:bg-hover hover:text-fg",
        className,
      )}
    >
      {icon && <span className="flex-none text-muted">{icon}</span>}
      {children}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-1.5 text-xs text-subtle">{children}</div>;
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-line" />;
}
