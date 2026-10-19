import { useT } from "@altair/i18n/react";
import type { ProjectFile } from "@altair/protocol";
import { ArrowUp, Paperclip } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/ui";
import { PendingAttachments } from "../files";

type Pending = { id: string; name: string; file?: ProjectFile; error?: string };

/**
 * The message box: grows with the text, Enter sends, Shift+Enter breaks the
 * line. `tools` renders in the bottom bar, left of Send (attachments, model
 * picker and the like plug in there). With `onUpload`, files can be attached
 * (paperclip, paste or drop); they upload right away and are sent by path.
 */
export function Composer({
  placeholder,
  onSend,
  onUpload,
  disabled,
  tools,
  autoFocus,
}: {
  placeholder: string;
  /** `attachments` are paths of files already uploaded with `onUpload`. */
  onSend: (body: string, attachments: string[]) => void;
  onUpload?: (file: File) => Promise<ProjectFile>;
  disabled?: boolean;
  tools?: ReactNode;
  autoFocus?: boolean;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const uploading = pending.some((p) => !p.file && !p.error);
  const ready = pending.flatMap((p) => (p.file ? [p.file.path] : []));

  function attach(files: File[]) {
    if (!onUpload) return;
    for (const file of files) {
      const id = crypto.randomUUID();
      setPending((list) => [...list, { id, name: file.name }]);
      onUpload(file).then(
        (uploaded) => setPending((list) => list.map((p) => (p.id === id ? { ...p, file: uploaded } : p))),
        (err) => setPending((list) => list.map((p) => (p.id === id ? { ...p, error: errorMessage(err, t) } : p))),
      );
    }
  }

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
    if ((!body && ready.length === 0) || disabled || uploading) return;
    onSend(body, ready);
    setDraft("");
    setPending([]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
  }

  return (
    <form
      onSubmit={submit}
      className="px-4 pb-4 pt-2 sm:px-5"
      onDragOver={(e) => onUpload && e.preventDefault()}
      onDrop={(e) => {
        if (!onUpload || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        attach([...e.dataTransfer.files]);
      }}
    >
      <div
        className="flex cursor-text flex-col gap-1 rounded-2xl border border-edge bg-raised px-3.5 pb-2 pt-3 shadow-[0_8px_24px_rgba(0,0,0,0.25)] transition-colors focus-within:border-[#3a3a44]"
        onClick={() => ref.current?.focus()}
      >
        <PendingAttachments items={pending} onRemove={(id) => setPending((list) => list.filter((p) => p.id !== id))} />
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (onUpload && e.clipboardData.files.length > 0) {
              e.preventDefault();
              attach([...e.clipboardData.files]);
            }
          }}
          rows={1}
          aria-label={placeholder}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className="max-h-[240px] min-h-6 resize-none bg-transparent text-fg outline-none placeholder:text-subtle"
        />
        <div className="-mr-1.5 flex items-center gap-1">
          {onUpload && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  picker.current?.click();
                }}
                aria-label={t("composer.attach")}
                title={t("composer.attach")}
                className="flex size-8 flex-none items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
              >
                <Paperclip size={16} />
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  attach([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
            </>
          )}
          {tools}
          <span className="ml-auto hidden pr-2 text-[11px] text-subtle sm:inline">
            {draft ? t("composer.newLineHint") : ""}
          </span>
          <button
            type="submit"
            aria-label={t("composer.send")}
            disabled={(!draft.trim() && ready.length === 0) || uploading || disabled}
            className="flex size-8 flex-none items-center justify-center rounded-[10px] bg-accent text-ground transition-opacity disabled:opacity-35 max-sm:ml-auto"
          >
            <ArrowUp size={17} strokeWidth={2.3} />
          </button>
        </div>
      </div>
    </form>
  );
}
