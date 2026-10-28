import { useT } from "@myrel/i18n/react";
import { DECISION_LANG, type Message, parseConnectorSuggestion, type Reaction } from "@myrel/protocol";
import { AlarmClock, CircleAlert, LoaderCircle, Pencil } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CliMark, useRelativeTime } from "../../lib/ui";
import { AttachmentList } from "../files";
import { Collapsible } from "./collapsible";
import { ConnectorSuggestionCard } from "./connector-suggestion-card";
import { CopyButton, type DecisionHandlers, MessageMarkdown } from "./markdown";
import { MessageStatsLine } from "./message-stats";
import { QueuedLine } from "./queued-line";
import { RelayNote } from "./relay-note";
import { StopButton } from "./stop-button";

export type Names = Record<string, string>;

/**
 * One message, Claude style: people's messages as bubbles on the right,
 * the assistant's as open text beside its mark (in a thread, the mark of the CLI that wrote it),
 * system notes as a banner.
 * `children` renders under the message (e.g. its thread card). `onEdit` lets the
 * person change their own message's text. `onInterrupt`: the message waits for the
 * thread's working agent, which this stops so it goes now.
 */
export function MessageView({
  message,
  me,
  names,
  reactions,
  decision,
  onEdit,
  onInterrupt,
  children,
}: {
  message: Message;
  me: string;
  names: Names;
  reactions?: Reaction[];
  decision?: DecisionHandlers;
  onEdit?: (body: string) => void;
  onInterrupt?: () => Promise<unknown>;
  children?: ReactNode;
}) {
  const t = useT();
  const relativeTime = useRelativeTime();
  if (message.authorKind === "system" && message.authorId === "routine") {
    const [title, ...rest] = message.body.replace(/^⏰\s*/, "").split("\n");
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2.5 rounded-xl border border-accent-line bg-accent-soft/60 px-3.5 py-2.5 text-[13px] text-body">
          <AlarmClock size={16} className="mt-0.5 flex-none text-accent" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block text-xs text-subtle">{t("routines.notice", { name: title ?? "" })}</span>
            <span className="whitespace-pre-wrap">{rest.join("\n").trim()}</span>
          </span>
        </div>
        {children}
      </div>
    );
  }

  if (message.authorKind === "system") {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-warn-line bg-warn-soft px-3.5 py-2.5 text-[13px] text-body">
        <CircleAlert size={16} className="mt-0.5 flex-none text-warn" aria-hidden="true" />
        <span className="whitespace-pre-wrap">{message.body}</span>
      </div>
    );
  }

  if (message.authorKind === "agent") {
    const suggestion = message.threadId ? parseConnectorSuggestion(message.body) : null;
    return (
      <div className="group flex gap-3.5">
        <CliMark cli={message.threadId ? (message.stats?.task?.harness ?? message.stats?.harness) : null} tile />
        <div className="flex min-w-0 flex-1 flex-col gap-3 pt-0.5">
          {suggestion ? (
            <ConnectorSuggestionCard suggestion={suggestion} projectId={message.projectId} threadId={message.threadId!} />
          ) : (
            <FoldIfLong body={message.body}>
              <MessageMarkdown body={message.body} decision={decision} />
            </FoldIfLong>
          )}
          {message.relay && <RelayNote relay={message.relay} />}
          <AttachmentList attachments={message.attachments} />
          {children}
          {message.stats && <MessageStatsLine stats={message.stats} />}
          <div className="-ml-1.5 -mt-1 flex items-center gap-1">
            <Reactions reactions={reactions} />
            <span className="flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
              {!suggestion && <CopyButton text={message.body} label={t("message.copy")} />}
              <time dateTime={message.createdAt} className="px-1 text-xs text-subtle">
                {relativeTime(message.createdAt)}
              </time>
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <PersonMessage
      message={message}
      names={names}
      reactions={reactions}
      onEdit={message.authorId === me ? onEdit : undefined}
      onInterrupt={onInterrupt}
    >
      {children}
    </PersonMessage>
  );
}

/** A person's bubble. Their own can be edited in place; an edited one says so, with the time on hover. */
function PersonMessage({
  message,
  names,
  reactions,
  onEdit,
  onInterrupt,
  children,
}: {
  message: Message;
  names: Names;
  reactions?: Reaction[];
  onEdit?: (body: string) => void;
  onInterrupt?: () => Promise<unknown>;
  children?: ReactNode;
}) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const [draft, setDraft] = useState<string | null>(null);
  const mine = !!onEdit;
  // A message with files may lose its text; one without keeps at least a word.
  const canSave = draft !== null && (draft.trim().length > 0 || !!message.attachments?.length);
  const save = () => {
    if (!canSave) return;
    if (draft.trim() !== message.body) onEdit?.(draft.trim());
    setDraft(null);
  };

  return (
    <div className="group flex flex-col items-end gap-1.5">
      {!mine && <span className="text-xs text-subtle">{names[message.authorId] ?? t("common.member")}</span>}
      {draft !== null ? (
        <div className="flex w-full max-w-[85%] flex-col gap-2 rounded-2xl rounded-br-md border border-accent-line bg-bubble px-3.5 py-2.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDraft(null);
              else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                save();
              }
            }}
            rows={Math.min(10, Math.max(2, draft.split("\n").length))}
            aria-label={t("message.edit")}
            className="w-full resize-y bg-transparent text-fg outline-none"
            autoFocus
          />
          <div className="flex items-center justify-end gap-2 text-xs">
            <span className="mr-auto text-subtle">{t("message.editHint")}</span>
            <button type="button" onClick={() => setDraft(null)} className="rounded-md px-2 py-1 text-muted hover:bg-hover">
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!canSave}
              className="rounded-md bg-accent px-2.5 py-1 font-medium text-ground hover:bg-accent-hover disabled:opacity-50"
            >
              {t("message.editSave")}
            </button>
          </div>
        </div>
      ) : (
        message.body && (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-edge bg-bubble px-3.5 py-2.5 text-fg">
            <Collapsible lines={10}>{message.body}</Collapsible>
          </div>
        )
      )}
      <div className="flex max-w-[85%] justify-end">
        <AttachmentList attachments={message.attachments} />
      </div>
      {draft === null && (message.editedAt || mine) && (
        <div className="flex items-center gap-1 text-xs text-subtle">
          {mine && (
            <button
              type="button"
              onClick={() => setDraft(message.body)}
              aria-label={t("message.edit")}
              title={t("message.edit")}
              className="rounded-md p-1 opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
            >
              <Pencil size={13} aria-hidden="true" />
            </button>
          )}
          {message.editedAt && (
            <time dateTime={message.editedAt} title={t("message.editedAt", { time: relativeTime(message.editedAt) })}>
              {t("message.edited")}
            </time>
          )}
        </div>
      )}
      {onInterrupt && draft === null && <QueuedLine onInterrupt={onInterrupt} />}
      <Reactions reactions={reactions} />
      {children && <div className="w-full max-w-[85%] self-end">{children}</div>}
    </div>
  );
}

/**
 * Agent replies fold later than people's messages, and never when they carry
 * a decision card: the card sits at the end and must stay in reach.
 */
function FoldIfLong({ body, children }: { body: string; children: ReactNode }) {
  if (body.includes("```" + DECISION_LANG)) return children;
  return <Collapsible lines={24}>{children}</Collapsible>;
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

/** The working line. `cli`: the CLI doing a thread's work, shown instead of Myrel's mark. */
export function Thinking({ label, cli, onStop }: { label?: string; cli?: string | null; onStop?: () => Promise<unknown> }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
      <CliMark cli={cli} tile />
      <span className="flex items-center gap-2 text-[13px] text-subtle" role="status">
        <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
        {label ?? t("message.thinking")}…
      </span>
      {onStop && <StopButton onStop={onStop} />}
    </div>
  );
}

/**
 * For each agent message, the first later message by a person in the same
 * conversation: that is the answer to any decision card it carries.
 */
export function decisionAnswers(messages: Message[]): Map<string, string> {
  const answers = new Map<string, string>();
  let pending: string[] = [];
  for (const m of messages) {
    if (m.authorKind === "agent") pending.push(m.id);
    else if (m.authorKind === "user") {
      for (const id of pending) answers.set(id, m.body);
      pending = [];
    }
  }
  return answers;
}
