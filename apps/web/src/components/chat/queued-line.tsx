import { useT } from "@myrel/i18n/react";
import { Clock, Square } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "../ui/confirm";

/**
 * Under a person's message the thread's agent has not taken in yet: it says the message waits, and
 * offers to stop the running turn so it goes now. The line goes away once the agent takes it in.
 */
export function QueuedLine({ onInterrupt }: { onInterrupt: () => Promise<unknown> }) {
  const t = useT();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const interrupt = async () => {
    if (!(await confirm({ title: t("message.interruptTitle"), body: t("message.interruptConfirm"), action: t("message.interrupt") }))) return;
    setBusy(true);
    setError(null);
    try {
      await onInterrupt();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("message.interruptFailed"));
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-subtle">
      <span className="flex items-center gap-1" title={t("message.queuedHint")}>
        <Clock size={12} aria-hidden="true" />
        {t("message.queued")}
      </span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        onClick={interrupt}
        disabled={busy}
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted hover:bg-hover hover:text-fg disabled:opacity-50"
      >
        <Square size={10} aria-hidden="true" />
        {t("message.interrupt")}
      </button>
      {error && (
        <span role="alert" className="basis-full text-right text-bad">
          {error}
        </span>
      )}
    </div>
  );
}
