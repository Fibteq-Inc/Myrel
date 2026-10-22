import { useT } from "@myrel/i18n/react";
import { DECISION_LANG, type Message, parseConnectorSuggestion, type Reaction } from "@myrel/protocol";
import { AlarmClock, CircleAlert, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { MyrelMark, useRelativeTime } from "../../lib/ui";
import { AttachmentList } from "../files";
import { Collapsible } from "./collapsible";
import { ConnectorSuggestionCard } from "./connector-suggestion-card";
import { CopyButton, type DecisionHandlers, MessageMarkdown } from "./markdown";
import { MessageStatsLine } from "./message-stats";
import { RelayNote } from "./relay-note";

export type Names = Record<string, string>;

/**
 * One message, Claude style: people's messages as bubbles on the right,
 * the assistant's as open text beside its mark, system notes as a banner.
 * `children` renders under the message (e.g. its thread card).
 */
export function MessageView({
  message,
  me,
  names,
  reactions,
  decision,
  children,
}: {
  message: Message;
  me: string;
  names: Names;
  reactions?: Reaction[];
  decision?: DecisionHandlers;
  children?: ReactNode;
}) {
  const t = useT();
  const relativeTime = useRelativeTime();
  if (message.authorKind === "system" && message.authorId === "routine") {
    const [title, ...rest] = message.body.replace(/^⏰\s*/, "").split("\n");
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2.5 rounded-xl border border-[#2b3060] bg-accent-soft/60 px-3.5 py-2.5 text-[13px] text-body">
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
      <div className="flex items-start gap-2.5 rounded-xl border border-[#3b3218] bg-[#17150f] px-3.5 py-2.5 text-[13px] text-body">
        <CircleAlert size={16} className="mt-0.5 flex-none text-warn" aria-hidden="true" />
        <span className="whitespace-pre-wrap">{message.body}</span>
      </div>
    );
  }

  if (message.authorKind === "agent") {
    const suggestion = message.threadId ? parseConnectorSuggestion(message.body) : null;
    return (
      <div className="group flex gap-3.5">
        <MyrelMark size={28} />
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

  const mine = message.authorId === me;
  return (
    <div className="group flex flex-col items-end gap-1.5">
      {!mine && <span className="text-xs text-subtle">{names[message.authorId] ?? t("common.member")}</span>}
      {message.body && (
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-edge bg-bubble px-3.5 py-2.5 text-fg">
          <Collapsible lines={10}>{message.body}</Collapsible>
        </div>
      )}
      <div className="flex max-w-[85%] justify-end">
        <AttachmentList attachments={message.attachments} />
      </div>
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

export function Thinking({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3.5" role="status">
      <MyrelMark size={28} />
      <span className="flex items-center gap-2 text-[13px] text-subtle">
        <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
        {label ?? t("message.thinking")}…
      </span>
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
