import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cn } from "../../lib/ui";

/**
 * A button that opens a floating panel below it. Closes on outside click,
 * Escape, or when `children` calls `close`.
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
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const position =
    side === "right"
      ? "left-full bottom-0 ml-2"
      : side === "top"
        ? cn("bottom-full mb-1.5", align === "end" ? "right-0" : "left-0")
        : cn("top-full mt-1.5", align === "end" ? "right-0" : "left-0");

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
      {open && (
        <div
          id={id}
          role="menu"
          aria-label={label}
          className={cn(
            "absolute z-50 min-w-56 rounded-xl border border-edge bg-[#17171b] p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.5)]",
            position,
            panelClassName,
          )}
        >
          {children(() => setOpen(false))}
        </div>
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
