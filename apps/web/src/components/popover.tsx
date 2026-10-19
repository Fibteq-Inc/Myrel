import { type CSSProperties, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A panel anchored to its trigger, rendered in a portal so sidebars and their
 * transforms cannot clip it. Closes on outside click or Escape.
 * placement "right": beside the anchor, bottoms aligned (icon rail). "below": under it, right edges aligned.
 */
export function Popover({
  open,
  onClose,
  anchor,
  placement,
  className = "",
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  placement: "right" | "below";
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const r = anchor.current!.getBoundingClientRect();
      setStyle(
        placement === "right"
          ? { left: r.right + 8, bottom: Math.max(8, innerHeight - r.bottom) }
          : { top: r.bottom + 8, right: Math.max(8, innerWidth - r.right) },
      );
    };
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, [open, anchor, placement]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      // Clicks on the trigger toggle it themselves.
      if (!ref.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      style={style}
      className={`fixed z-50 rounded-xl border border-edge bg-panel shadow-2xl shadow-black/50 ${className}`}
    >
      {children}
    </div>,
    document.body,
  );
}
