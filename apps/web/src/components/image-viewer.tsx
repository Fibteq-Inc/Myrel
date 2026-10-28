import { useT } from "@myrel/i18n/react";
import { Download, Minus, Plus, Scan, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { IconButton } from "../lib/ui";

const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
const STEP = 1.25;

type View = { scale: number; x: number; y: number };

/**
 * An image over the whole screen: it opens fit to the window (never past its own size), zooms with
 * the wheel, a pinch, double-click or the buttons (+, - and 0 on the keyboard too) around the
 * pointer, and pans by dragging. Escape or a click on the backdrop closes it.
 */
export function ImageViewer({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);
  // null: fit to the window, following its size.
  const [view, setView] = useState<View | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fit = natural && stage ? Math.min(1, stage.w / natural.w, stage.h / natural.h) : 1;
  const current: View = view ?? { scale: fit, x: 0, y: 0 };

  /** Zooms to `scale`, keeping the point at (px, py) from the stage's center where it is. */
  const zoomTo = (scale: number, px = 0, py = 0) => {
    setView((prev) => {
      const from = prev ?? { scale: fit, x: 0, y: 0 };
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
      const ratio = next / from.scale;
      return { scale: next, x: px - (px - from.x) * ratio, y: py - (py - from.y) * ratio };
    });
  };

  /** A point in client coordinates, measured from the stage's center. */
  const fromCenter = (clientX: number, clientY: number) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };

  // React's onWheel is passive, so the page would scroll too; this one can prevent that.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = fromCenter(e.clientX, e.clientY);
      // Trackpad pinches come as ctrl+wheel with small deltas; mouse wheels as larger steps.
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      setView((prev) => {
        const from = prev ?? { scale: fit, x: 0, y: 0 };
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, from.scale * factor));
        const ratio = next / from.scale;
        return { scale: next, x: p.x - (p.x - from.x) * ratio, y: p.y - (p.y - from.y) * ratio };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [fit]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") zoomTo(current.scale * STEP);
    else if (e.key === "-") zoomTo(current.scale / STEP);
    else if (e.key === "0") setView(null);
    else return;
    e.preventDefault();
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    pinch.current = null;
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current) {
        const mid = fromCenter((a.x + b.x) / 2, (a.y + b.y) / 2);
        zoomTo(current.scale * (distance / pinch.current), mid.x, mid.y);
      }
      pinch.current = distance;
      if (drag.current) drag.current.moved = true;
      return;
    }
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    setView((prev) => {
      const from = prev ?? { scale: fit, x: 0, y: 0 };
      return { ...from, x: from.x + dx, y: from.y + dy };
    });
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    // A plain click beside the picture closes the viewer, as one on the backdrop would.
    if (d.moved || !natural) return;
    const p = fromCenter(e.clientX, e.clientY);
    const halfW = (natural.w * current.scale) / 2;
    const halfH = (natural.h * current.scale) / 2;
    if (Math.abs(p.x - current.x) > halfW || Math.abs(p.y - current.y) > halfH) onClose();
  };

  const toolbarButton = "text-white/80 hover:bg-white/10 hover:text-white";

  return (
    <dialog
      ref={dialogRef}
      {...{ closedby: "any" }}
      aria-label={name}
      onClose={onClose}
      onKeyDown={onKeyDown}
      className="m-0 h-dvh max-h-none w-screen max-w-none flex-col overflow-hidden bg-black p-0 text-white backdrop:bg-black/60 open:flex"
    >
      <div className="flex h-12 flex-none items-center gap-1 px-3">
        <span className="min-w-0 flex-1 truncate pl-1 text-[13px] font-medium" title={name}>
          {name}
        </span>
        <IconButton type="button" onClick={() => zoomTo(current.scale / STEP)} aria-label={t("files.zoomOut")} title={t("files.zoomOut")} className={toolbarButton}>
          <Minus size={16} />
        </IconButton>
        <button
          type="button"
          onClick={() => zoomTo(1)}
          title={t("files.actualSize")}
          className="h-9 min-w-14 rounded-lg px-2 text-xs tabular-nums text-white/80 hover:bg-white/10 hover:text-white"
        >
          {Math.round(current.scale * 100)}%
        </button>
        <IconButton type="button" onClick={() => zoomTo(current.scale * STEP)} aria-label={t("files.zoomIn")} title={t("files.zoomIn")} className={toolbarButton}>
          <Plus size={16} />
        </IconButton>
        <IconButton type="button" onClick={() => setView(null)} aria-label={t("files.fitToScreen")} title={t("files.fitToScreen")} className={toolbarButton}>
          <Scan size={16} />
        </IconButton>
        <a
          href={url}
          download={name}
          aria-label={t("files.download")}
          title={t("files.download")}
          className={`inline-flex size-9 items-center justify-center rounded-lg ${toolbarButton}`}
        >
          <Download size={16} />
        </a>
        <IconButton type="button" onClick={onClose} aria-label={t("files.closeFullscreen")} title={t("files.closeFullscreen")} className={toolbarButton}>
          <X size={17} />
        </IconButton>
      </div>
      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 cursor-grab touch-none select-none overflow-hidden active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => {
          const p = fromCenter(e.clientX, e.clientY);
          if (view && Math.abs(view.scale - fit) > 0.01) setView(null);
          else zoomTo(Math.max(fit * 2.5, 1), p.x, p.y);
        }}
      >
        <img
          src={url}
          alt={name}
          draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          className="pointer-events-none absolute left-1/2 top-1/2 max-w-none"
          style={{
            width: natural?.w,
            height: natural?.h,
            visibility: natural && stage ? "visible" : "hidden",
            transform: `translate(-50%, -50%) translate(${current.x}px, ${current.y}px) scale(${current.scale})`,
          }}
        />
      </div>
    </dialog>
  );
}
