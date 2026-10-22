import { projectChat, threadByCard, threadReplyCount } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import { decisionPicks } from "@myrel/protocol";
import { LoaderCircle, MessagesSquare } from "lucide-react";
import { useCallback } from "react";
import { api } from "../../lib/api";
import { useProjectContext } from "../../lib/project-context";
import { cn } from "../../lib/ui";
import { ArtifactCards } from "../artifacts";
import { Composer } from "./composer";
import { EarlierMessages, useHistoryWindow } from "./history";
import { decisionAnswers, MessageView, Thinking } from "./message";
import { ScrollToEnd } from "./scroll-to-end";
import { ThreadCard } from "./thread-card";

/** The project chat: everything said to the coordinator, with a card for each thread it opened. */
export function ProjectChat({ me, className = "" }: { me: string; className?: string }) {
  const t = useT();
  const { project, names, state, ready, send } = useProjectContext();
  const chat = projectChat(state);
  const history = useHistoryWindow(chat);
  const choose = useCallback((label: string) => send(label), [send]);
  const roots = threadByCard(state);
  const answers = decisionAnswers(chat);
  // A tap on a card is shown on the card itself, not again as a bubble.
  const picks = decisionPicks(chat);
  const thinking = !!state.active[""];
  const last = chat.at(-1);

  return (
    <div className={cn("@container flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <ScrollToEnd
        last={last?.id}
        busy={thinking}
        mine={last?.authorKind === "user" && last.authorId === me}
        className="flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-7 px-4 py-7 sm:px-6">
          {chat.length === 0 && (ready ? <EmptyChat /> : <LoadingChat />)}
          <EarlierMessages hidden={history.hidden} onShow={history.showEarlier} />
          {history.visible.map((m) => {
            const thread = roots.get(m.id);
            // A pick that opened a thread keeps its bubble, which carries the thread's card.
            if (picks.has(m.id) && !thread) return null;
            return (
              <MessageView
                key={m.id}
                message={m}
                me={me}
                names={names}
                reactions={state.reactions[m.id]}
                decision={{ answer: answers.get(m.id), onChoose: choose }}
              >
                {m.artifacts?.length ? (
                  <ArtifactCards projectId={project.id} refs={m.artifacts} artifacts={state.artifacts} />
                ) : null}
                {thread && (
                  <ThreadCard projectId={project.id} thread={thread} replies={threadReplyCount(state, thread.id)} />
                )}
              </MessageView>
            );
          })}
          {thinking && <Thinking />}
        </div>
      </ScrollToEnd>

      <div className="mx-auto w-full max-w-[808px]">
        <Composer
          placeholder={t("chat.placeholder")}
          onSend={(body, attachments) => send(body, null, attachments)}
          onUpload={(file) => api.upload(project.id, file.name, file)}
          autoFocus
        />
      </div>
    </div>
  );
}

function LoadingChat() {
  const t = useT();
  return (
    <div className="flex justify-center py-20 text-subtle">
      <LoaderCircle size={20} className="animate-spin" aria-label={t("chat.loading")} />
    </div>
  );
}

function EmptyChat() {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-2 py-20 text-center">
      <span className="mb-2 flex size-12 items-center justify-center rounded-2xl border border-line bg-raised">
        <MessagesSquare size={22} className="text-muted" aria-hidden="true" />
      </span>
      <p className="text-base font-medium">{t("chat.emptyTitle")}</p>
      <p className="max-w-sm text-[13px] text-subtle">{t("chat.emptyBody")}</p>
    </div>
  );
}
