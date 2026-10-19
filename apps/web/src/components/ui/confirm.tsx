import { useT } from "@altair/i18n/react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Button, GhostButton } from "../../lib/ui";

type ConfirmOptions = {
  title: string;
  body?: string;
  /** The confirm button's label, e.g. "Delete". */
  action: string;
  /** Paints the confirm button red for deletes and removals. */
  danger?: boolean;
};

type Ask = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Ask | null>(null);

/** Hosts the app's confirm dialog; `useConfirm()` asks through it in place of `window.confirm`. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const ask = useCallback<Ask>((options) => new Promise((resolve) => setPending({ ...options, resolve })), []);
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {pending && (
        <ConfirmDialog
          {...pending}
          onDone={(ok) => {
            pending.resolve(ok);
            setPending(null);
          }}
        />
      )}
    </ConfirmContext.Provider>
  );
}

/** Asks a yes/no question in a dialog; resolves true when confirmed. */
export function useConfirm() {
  const ask = useContext(ConfirmContext);
  if (!ask) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ask;
}

function ConfirmDialog({ title, body, action, danger, onDone }: ConfirmOptions & { onDone: (ok: boolean) => void }) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const answered = useRef(false);
  const finish = (ok: boolean) => {
    if (answered.current) return;
    answered.current = true;
    onDone(ok);
  };

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return (
    <dialog
      ref={ref}
      // Esc and a backdrop click cancel; older browsers get the backdrop click from onClick below.
      {...{ closedby: "any" }}
      aria-labelledby="confirm-title"
      aria-describedby={body ? "confirm-body" : undefined}
      onClose={() => finish(false)}
      onClick={(e) => e.target === e.currentTarget && finish(false)}
      className="m-auto w-[min(420px,calc(100vw-32px))] rounded-2xl border border-edge bg-[#17171b] p-0 text-fg shadow-[0_16px_48px_rgba(0,0,0,0.55)] backdrop:bg-black/60"
    >
      <form
        method="dialog"
        className="flex flex-col gap-2 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
      >
        <h2 id="confirm-title" className="text-[15px] font-semibold">
          {title}
        </h2>
        {body && (
          <p id="confirm-body" className="text-[13px] text-muted">
            {body}
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <GhostButton type="button" onClick={() => finish(false)} autoFocus className="h-9 px-3">
            {t("common.cancel")}
          </GhostButton>
          {danger ? (
            <button
              type="submit"
              className="inline-flex h-9 items-center justify-center rounded-lg bg-[#e5484d] px-3 text-sm font-medium text-white hover:bg-[#d93f44]"
            >
              {action}
            </button>
          ) : (
            <Button type="submit">{action}</Button>
          )}
        </div>
      </form>
    </dialog>
  );
}
