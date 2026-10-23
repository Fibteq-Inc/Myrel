import { useT } from "@myrel/i18n/react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { GhostButton, Input } from "../../lib/ui";

/**
 * A modal confirmation for destructive actions, in place of the browser's confirm().
 * With `typeToConfirm`, the confirm button stays disabled until that text is typed.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busyLabel,
  typeToConfirm,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  typeToConfirm?: string;
  busy?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  const ready = !typeToConfirm || typed.trim() === typeToConfirm.trim();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (ready && !busy) onConfirm();
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      onClose={onClose}
      onCancel={(e) => busy && e.preventDefault()}
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}
      className="m-auto w-[min(440px,calc(100vw-32px))] rounded-2xl border border-line bg-ground p-0 text-fg shadow-2xl backdrop:bg-black/60"
    >
      <form onSubmit={onSubmit} className="space-y-4 p-5">
        <h2 id="confirm-title" className="text-[15px] font-semibold">
          {title}
        </h2>
        <div className="text-[13px] leading-relaxed text-muted">{body}</div>
        {typeToConfirm && (
          <label className="block space-y-1.5">
            <span className="block text-[13px] text-muted">{t("deleteProject.typeName", { name: typeToConfirm })}</span>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
          </label>
        )}
        {error && <p className="text-[13px] text-bad">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <GhostButton type="button" className="h-9" onClick={onClose} disabled={busy}>
            {t("deleteProject.cancel")}
          </GhostButton>
          <button
            type="submit"
            disabled={!ready || busy}
            className="inline-flex h-9 items-center justify-center rounded-lg bg-bad px-3 text-sm font-medium text-ground hover:bg-bad-bright disabled:opacity-50"
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
