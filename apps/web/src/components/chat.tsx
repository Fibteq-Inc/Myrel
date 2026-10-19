import { parseChecklist } from "@altair/client";
import type { Message, ProjectFile, Reaction, Thread } from "@altair/protocol";
import { Link } from "@tanstack/react-router";
import {
  ArrowUp,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePause,
  LoaderCircle,
  MessageSquareText,
  Paperclip,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AltairMark, errorMessage } from "../lib/ui";
import { AttachmentList, PendingAttachments } from "./files";

export type Names = Record<string, string>;

export function MessageView({
  message,
  me,
  names,
  reactions,
  onOpenFile,
  children,
}: {
  message: Message;
  me: string;
  names: Names;
  reactions?: Reaction[];
  /** Opens an attached file's preview. */
  onOpenFile: (path: string) => void;
  children?: ReactNode;
}) {
  if (message.authorKind === "system") {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-[#3b3218] bg-[#17150f] px-3.5 py-2.5 text-[13px] text-body">
        <CircleAlert size={16} className="mt-0.5 flex-none text-warn" aria-hidden="true" />
        <span className="whitespace-pre-wrap">{message.body}</span>
      </div>
    );
  }

  if (message.authorKind === "agent") {
    return (
      <div className="flex gap-3.5">
        <AltairMark size={30} />
        <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1">
          <div className="prose-altair">
            <Markdown remarkPlugins={[remarkGfm]}>{message.body}</Markdown>
          </div>
          <AttachmentList attachments={message.attachments} onOpen={onOpenFile} />
          <Reactions reactions={reactions} />
          {children}
        </div>
      </div>
    );
  }

  const mine = message.authorId === me;
  return (
    <div className="flex flex-col items-end gap-1.5">
      {!mine && <span className="text-xs text-subtle">{names[message.authorId] ?? "Member"}</span>}
      {message.body && (
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-edge bg-bubble px-3.5 py-2.5 text-fg">
          {message.body}
        </div>
      )}
      <div className="flex max-w-[85%] justify-end">
        <AttachmentList attachments={message.attachments} onOpen={onOpenFile} />
      </div>
      <Reactions reactions={reactions} />
      {children && <div className="w-full max-w-[85%] self-end">{children}</div>}
    </div>
  );
}

function Reactions({ reactions }: { reactions?: Reaction[] }) {
  if (!reactions?.length) return null;
  const counts = new Map<string, number>();
  for (const r of reactions) counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);
  return (
    <div className="flex gap-1">
      {[...counts].map(([emoji, n]) => (
        <span key={emoji} className="rounded-full border border-edge bg-raised px-2 py-0.5 text-xs">
          {emoji}
          {n > 1 && <span className="ml-1 text-subtle">{n}</span>}
        </span>
      ))}
    </div>
  );
}

const STATUS: Record<string, { label: string; icon: ReactNode }> = {
  working: { label: "Working", icon: <LoaderCircle size={16} className="animate-spin text-accent" /> },
  blocked: { label: "Checking with the coordinator", icon: <CirclePause size={16} className="text-warn" /> },
  review_ready: { label: "Replied", icon: <MessageSquareText size={16} className="text-muted" /> },
  done: { label: "Resolved", icon: <CircleCheck size={16} className="text-ok" /> },
  failed: { label: "Failed", icon: <CircleAlert size={16} className="text-bad" /> },
};

export function threadStatus(thread: Thread) {
  return STATUS[thread.resolved ? "done" : thread.status]!;
}

export function ThreadCard({
  projectId,
  thread,
  replies,
  open,
}: {
  projectId: string;
  thread: Thread;
  replies: number;
  open: boolean;
}) {
  const status = threadStatus(thread);
  const step = thread.status === "working" && thread.statusText ? currentStep(thread.statusText) : null;
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId }}
      search={{ thread: thread.id }}
      className={`flex flex-col overflow-hidden rounded-xl border bg-raised text-fg hover:border-edge ${
        open ? "border-accent/60" : "border-[#26262b]"
      }`}
    >
      <span className="flex items-center gap-2.5 px-3.5 py-3">
        <span aria-hidden="true">{status.icon}</span>
        <span className="truncate font-semibold">{thread.title}</span>
        <span className="ml-auto flex-none text-xs text-subtle">
          {replies === 1 ? "1 reply" : `${replies} replies`}
        </span>
        <ChevronRight size={15} className="flex-none text-subtle" aria-hidden="true" />
      </span>
      <span className="flex items-center gap-2 border-t border-[#222227] bg-panel px-3.5 py-2 text-xs text-muted">
        {step ?? status.label}
      </span>
    </Link>
  );
}

function currentStep(statusText: string) {
  const { items } = parseChecklist(statusText);
  return items.find((i) => i.state === "active")?.text ?? null;
}

export function Checklist({ text }: { text: string }) {
  const { title, items } = parseChecklist(text);
  if (items.length === 0) return <div className="whitespace-pre-wrap text-[13px] text-muted">{text}</div>;
  const done = items.filter((i) => i.state === "done").length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-subtle">
        {title || "Progress"}
        <span className="ml-auto font-mono">
          {done} / {items.length}
        </span>
      </div>
      <div aria-hidden="true" className="h-1 overflow-hidden rounded bg-[#222227]">
        <div className="h-full rounded bg-accent transition-all" style={{ width: `${(done / items.length) * 100}%` }} />
      </div>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {items.map((item, i) => (
          <li
            key={i}
            className={`flex items-center gap-2 ${
              item.state === "done" ? "text-muted" : item.state === "active" ? "font-medium text-fg" : "text-subtle"
            }`}
          >
            {item.state === "done" && <CircleCheck size={15} className="flex-none text-ok" aria-hidden="true" />}
            {item.state === "active" && (
              <LoaderCircle size={15} className="flex-none animate-spin text-accent" aria-hidden="true" />
            )}
            {item.state === "todo" && <CircleDashed size={15} className="flex-none" aria-hidden="true" />}
            {item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Thinking({ label = "Thinking" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3.5" role="status">
      <AltairMark size={30} />
      <span className="flex items-center gap-2 text-[13px] text-subtle">
        <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
        {label}…
      </span>
    </div>
  );
}

type Pending = { id: string; name: string; file?: ProjectFile; error?: string };

export function Composer({
  placeholder,
  onSend,
  onUpload,
  disabled,
}: {
  placeholder: string;
  /** `attachments` are paths of files already uploaded with `onUpload`. */
  onSend: (body: string, attachments: string[]) => void;
  onUpload?: (file: File) => Promise<ProjectFile>;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const uploading = pending.some((p) => !p.file && !p.error);
  const ready = pending.flatMap((p) => (p.file ? [p.file.path] : []));

  function attach(files: File[]) {
    if (!onUpload) return;
    for (const file of files) {
      const id = crypto.randomUUID();
      setPending((list) => [...list, { id, name: file.name }]);
      onUpload(file).then(
        (uploaded) => setPending((list) => list.map((p) => (p.id === id ? { ...p, file: uploaded } : p))),
        (err) => setPending((list) => list.map((p) => (p.id === id ? { ...p, error: errorMessage(err) } : p))),
      );
    }
  }

  // Grow with the text, up to a cap.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
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
      <PendingAttachments items={pending} onRemove={(id) => setPending((list) => list.filter((p) => p.id !== id))} />
      <div className={`flex items-end gap-2 rounded-2xl border border-edge bg-raised py-2.5 pr-2.5 ${onUpload ? "pl-2" : "pl-3.5"} focus-within:border-[#3a3a44]`}>
        {onUpload && (
          <>
            <button
              type="button"
              onClick={() => picker.current?.click()}
              aria-label="Attach files"
              title="Attach files"
              className="flex size-9 flex-none items-center justify-center rounded-[10px] text-muted hover:bg-hover hover:text-fg"
            >
              <Paperclip size={17} />
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
          className="max-h-[220px] flex-1 resize-none bg-transparent py-1.5 text-fg outline-none placeholder:text-subtle"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={(!draft.trim() && ready.length === 0) || uploading || disabled}
          className="flex size-9 flex-none items-center justify-center rounded-[10px] bg-accent text-ground disabled:opacity-40"
        >
          <ArrowUp size={17} strokeWidth={2.3} />
        </button>
      </div>
    </form>
  );
}
