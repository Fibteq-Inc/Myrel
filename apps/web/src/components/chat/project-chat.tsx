import { projectChat, threadByRoot, threadMessages } from "@altair/client";
import { useT } from "@altair/i18n/react";
import { Link } from "@tanstack/react-router";
import { Blocks, FolderOpen, Hash, MessagesSquare, Settings } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { useProjectContext } from "../../lib/project-context";
import { cn } from "../../lib/ui";
import { ArtifactCards } from "../artifacts";
import { WorkspaceButton } from "../local-folder";
import { useOpenProjectSettings } from "../project-settings-dialog";
import { RoutinesButton, RoutinesPanel } from "../routines";
import { NavToggle, PaneHeader } from "../shell/shell";
import { Composer } from "./composer";
import { decisionAnswers, MessageView, Thinking } from "./message";
import { ScrollToEnd } from "./scroll-to-end";
import { ThreadCard } from "./thread-card";

const headerIcon =
  "flex size-9 flex-none items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg";

/** The project chat: everything said to the coordinator, with a card for each thread it opened. */
export function ProjectChat({ me, className = "" }: { me: string; className?: string }) {
  const t = useT();
  const { project, names, state, send } = useProjectContext();
  const openSettings = useOpenProjectSettings();
  const artifacts = Object.keys(state.artifacts).length;
  const routines = Object.values(state.routines);
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const chat = projectChat(state);
  const roots = threadByRoot(state);
  const answers = decisionAnswers(chat);
  const thinking = !!state.active[""];

  return (
    <main className={cn("@container flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <PaneHeader>
        <NavToggle />
        <Hash size={17} className="flex-none text-muted" aria-hidden="true" />
        <h1 className="flex-none text-[15px] font-semibold">{t("chat.title")}</h1>
        <span className="hidden truncate text-xs text-subtle sm:inline @max-[640px]:!hidden">{project.name}</span>
        <div className="ml-auto flex-none whitespace-nowrap">
          <WorkspaceButton project={project} />
        </div>
        <div className="-mr-2 ml-1 flex flex-none items-center">
          <Link
            to="/projects/$projectId/files"
            params={{ projectId: project.id }}
            aria-label={t("sidebar.files")}
            title={t("sidebar.files")}
            className={headerIcon}
          >
            <FolderOpen size={16} />
          </Link>
          <Link
            to="/projects/$projectId/artifacts"
            params={{ projectId: project.id }}
            aria-label={artifacts ? t("chat.artifactsCount", { count: artifacts }) : t("sidebar.artifacts")}
            title={t("sidebar.artifacts")}
            className={cn(headerIcon, "relative")}
          >
            <Blocks size={16} />
            {artifacts > 0 && (
              <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-raised px-1 text-center font-mono text-[10px] leading-4 text-muted">
                {artifacts}
              </span>
            )}
          </Link>
          <RoutinesButton onClick={() => setRoutinesOpen(true)} count={routines.length} className={headerIcon} />
          <button
            type="button"
            onClick={openSettings}
            aria-label={t("chat.projectSettings")}
            title={t("chat.projectSettings")}
            className={headerIcon}
          >
            <Settings size={16} />
          </button>
        </div>
      </PaneHeader>
      {routinesOpen && (
        <RoutinesPanel
          projectId={project.id}
          routines={routines}
          threads={Object.values(state.threads)}
          onClose={() => setRoutinesOpen(false)}
        />
      )}

      <ScrollToEnd dep={chat.length + (thinking ? 1 : 0)} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-7 px-4 py-7 sm:px-6">
          {chat.length === 0 && <EmptyChat />}
          {chat.map((m) => {
            const thread = roots.get(m.id);
            return (
              <MessageView
                key={m.id}
                message={m}
                me={me}
                names={names}
                reactions={state.reactions[m.id]}
                decision={{ answer: answers.get(m.id), onChoose: (label) => send(label) }}
              >
                {m.artifacts?.length ? (
                  <ArtifactCards projectId={project.id} refs={m.artifacts} artifacts={state.artifacts} />
                ) : null}
                {thread && (
                  <ThreadCard projectId={project.id} thread={thread} replies={threadMessages(state, thread.id).length} />
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
    </main>
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
