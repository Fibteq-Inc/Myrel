import { useT } from "@myrel/i18n/react";
import { Square } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "../ui/confirm";

/**
 * Next to a thread's "Working" line: stops its agent's turn, and anything waiting to continue it,
 * without going to the Terminal tab. A message written meanwhile goes to the running agent rather
 * than stopping it, so this is the way to stop it from the chat.
 */
export function StopButton({ onStop }: { onStop: () => Promise<unknown> }) {
  const t = useT();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    if (!(await confirm({ title: t("message.stopTitle"), body: t("message.stopConfirm"), action: t("message.stop") }))) return;
    setBusy(true);
    setError(null);
    try {
      await onStop();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("message.stopFailed"));
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={stop}
        disabled={busy}
        className="flex flex-none items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg disabled:opacity-50"
      >
        <Square size={10} aria-hidden="true" />
        {t("message.stop")}
      </button>
      {error && (
        <span role="alert" className="basis-full pl-[42px] text-xs text-bad">
          {error}
        </span>
      )}
    </>
  );
}
