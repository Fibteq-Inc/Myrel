import { conversationState, draftKey, projectChat, threadByCard, threadReplyCount } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import { type CliId, decisionPicks, type Message } from "@myrel/protocol";
import { MessagesSquare } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useProjectContext } from "../../lib/project-context";
import { cn } from "../../lib/ui";
import { ArtifactCards } from "../artifacts";
import { AskCliPicker, OfferedClis, usePickableClis } from "./cli-picker";
import { Composer, type ComposerHandle } from "./composer";
import { GoalBanner } from "./goal-banner";
import { EarlierMessages, useHistoryWindow } from "./history";
import { decisionAnswers, MessageView, Thinking } from "./message";
import { ScrollToEnd } from "./scroll-to-end";
import { ChatSkeleton } from "./skeleton";
import { StarterExamples, StarterList } from "./starter";
import { ThreadCard } from "./thread-card";

const NONE: Message[] = [];

/** The project chat: everything said to the coordinator, with a card for each thread it opened. */
export function ProjectChat({ me, className = "" }: { me: string; className?: string }) {
  const t = useT();
  const { project, names, state, ready, send, emit, loadConversation } = useProjectContext();
  // Drawn once the first sync is done, so a long chat opens at its end instead of scrolling there as pages arrive.
  const chat = ready ? projectChat(state) : NONE;
  const history = useHistoryWindow(chat, {
    hasEarlier: ready && conversationState(state, null).hasEarlier,
    load: () => loadConversation(null, chat[0]?.seq),
  });
  const choose = useCallback((label: string) => send(label), [send]);
  const roots = threadByCard(state);
  const answers = decisionAnswers(chat);
  // A tap on a card is shown on the card itself, not again as a bubble.
  const picks = decisionPicks(chat);
  const thinking = !!state.active[""];
  const last = chat.at(-1);
  // The CLIs the next ask's thread may run with; each ask picks its own.
  const pickable = usePickableClis(project);
  const [clis, setClis] = useState<CliId[]>([]);
  const composer = useRef<ComposerHandle>(null);
  const asked = chat.length > 0;

  return (
    <div className={cn("@container flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      {asked && (
        <div className="flex justify-center px-4 pt-3 sm:px-6">
          <StarterList project={project} asked folded />
        </div>
      )}
      {state.goal && (
        <div className="mx-auto w-full max-w-[760px] px-4 pt-3 sm:px-6">
          <GoalBanner goal={state.goal} onStop={() => emit({ type: "goal.stop" })} />
        </div>
      )}
      <ScrollToEnd
        last={last?.id}
        busy={thinking}
        mine={last?.authorKind === "user" && last.authorId === me}
        className="flex-1 overflow-y-auto"
      >
        {/* While loading, the placeholder sits at the bottom, where the newest messages will. */}
        <div className={cn("mx-auto flex w-full max-w-[760px] flex-col gap-7 px-4 py-7 sm:px-6", !ready && "h-full justify-end overflow-hidden")}>
          {!asked &&
            (ready ? (
              <EmptyChat>
                <StarterExamples onPick={(text, select) => composer.current?.fill(text, select)} />
                <StarterList project={project} asked={false} />
              </EmptyChat>
            ) : (
              <ChatSkeleton />
            ))}
          <EarlierMessages hidden={history.hidden} more={history.more} loading={history.loading} onShow={history.showEarlier} />
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
                onEdit={(body) => emit({ type: "message.edit", messageId: m.id, body })}
              >
                {m.artifacts?.length ? (
                  <ArtifactCards projectId={project.id} refs={m.artifacts} artifacts={state.artifacts} />
                ) : null}
                {m.clis?.length ? <OfferedClis clis={m.clis} /> : null}
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
          onSend={(body, attachments) => {
            send(body, null, attachments, pickable ? clis : []);
            setClis([]);
          }}
          onUpload={(file) => api.upload(project.id, file.name, file)}
          tools={pickable && <AskCliPicker pickable={pickable} value={clis} onChange={setClis} />}
          autoFocus
          handle={composer}
          draftKey={draftKey(project.id)}
        />
      </div>
    </div>
  );
}

/** What an empty project chat says, with the example tasks and the starter list under it. */
function EmptyChat({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center sm:py-16">
      <span className="mb-2 flex size-12 items-center justify-center rounded-2xl border border-line bg-raised">
        <MessagesSquare size={22} className="text-muted" aria-hidden="true" />
      </span>
      <p className="text-base font-medium">{t("chat.emptyTitle")}</p>
      <p className="max-w-sm text-[13px] text-subtle">
        {t("chat.emptyBody")} {t("starter.try")}
      </p>
      <div className="mt-4 flex w-full flex-col gap-4">{children}</div>
    </div>
  );
}
