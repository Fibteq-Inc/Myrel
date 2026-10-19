import { ArrowUp } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";

/**
 * The message box: grows with the text, Enter sends, Shift+Enter breaks the
 * line. `tools` renders in the bottom bar, left of Send (attachments, model
 * picker and the like plug in there).
 */
export function Composer({
  placeholder,
  onSend,
  disabled,
  tools,
  autoFocus,
}: {
  placeholder: string;
  onSend: (body: string) => void;
  disabled?: boolean;
  tools?: ReactNode;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to a cap.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const body = draft.trim();
    if (!body || disabled) return;
    onSend(body);
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
  }

  return (
    <form onSubmit={submit} className="px-4 pb-4 pt-2 sm:px-5">
      <div
        className="flex cursor-text flex-col gap-1 rounded-2xl border border-edge bg-raised px-3.5 pb-2 pt-3 shadow-[0_8px_24px_rgba(0,0,0,0.25)] transition-colors focus-within:border-[#3a3a44]"
        onClick={() => ref.current?.focus()}
      >
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          aria-label={placeholder}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className="max-h-[240px] min-h-6 resize-none bg-transparent text-fg outline-none placeholder:text-subtle"
        />
        <div className="-mr-1.5 flex items-center gap-1">
          {tools}
          <span className="ml-auto hidden pr-2 text-[11px] text-subtle sm:inline">
            {draft ? "Shift + Enter for a new line" : ""}
          </span>
          <button
            type="submit"
            aria-label="Send"
            disabled={!draft.trim() || disabled}
            className="flex size-8 flex-none items-center justify-center rounded-[10px] bg-accent text-ground transition-opacity disabled:opacity-35 max-sm:ml-auto"
          >
            <ArrowUp size={17} strokeWidth={2.3} />
          </button>
        </div>
      </div>
    </form>
  );
}
