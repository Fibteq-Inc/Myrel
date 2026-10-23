import { useT } from "@myrel/i18n/react";
import type { MessageRelay } from "@myrel/protocol";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "../../lib/ui";
import { CopyButton, MessageMarkdown } from "./markdown";

/** A note this long starts folded inside the open box, so it never takes over the chat. */
const LONG_NOTE_CHARS = 1200;
const LONG_NOTE_LINES = 12;

/**
 * What the coordinator sent a thread, folded under the line that announces it, so people can check
 * that their message went through and what was said.
 */
export function RelayNote({ relay }: { relay: MessageRelay }) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const long = relay.note.length > LONG_NOTE_CHARS || relay.note.split("\n").length > LONG_NOTE_LINES;
  const [full, setFull] = useState(false);
  return (
    <div className="-mt-1 flex flex-col items-start gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-full border border-edge px-2.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"
      >
        {open ? t("relay.hide") : t("relay.show")}
        <ChevronDown size={13} className={cn("transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        <div id={id} className="w-full rounded-xl border border-accent-line bg-accent-soft/40 px-3.5 py-2.5 text-[13px]">
          <div className="mb-1 flex items-center justify-between gap-2 text-xs text-subtle">
            <span>{t(`relay.kind.${relay.kind}`)}</span>
            <CopyButton text={relay.note} label={t("relay.copy")} />
          </div>
          <div
            className={cn(
              long && !full && "max-h-56 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
            )}
          >
            <MessageMarkdown body={relay.note} />
          </div>
          {long && (
            <button type="button" onClick={() => setFull((f) => !f)} className="mt-1 text-xs text-accent hover:underline">
              {full ? t("relay.less") : t("relay.more")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
