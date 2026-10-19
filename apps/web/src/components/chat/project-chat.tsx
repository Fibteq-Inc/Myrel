import { projectChat, threadByRoot, threadMessages } from "@altair/client";
import { Link } from "@tanstack/react-router";
import { Hash, MessagesSquare, Settings } from "lucide-react";
import { api } from "../../lib/api";
import { useProjectContext } from "../../lib/project-context";
import { cn, UserAvatar } from "../../lib/ui";
import { WorkspaceButton } from "../local-folder";
import { NavToggle, PaneHeader } from "../shell/shell";
import { Composer } from "./composer";
import { decisionAnswers, MessageView, Thinking } from "./message";
import { ScrollToEnd } from "./scroll-to-end";
import { ThreadCard } from "./thread-card";

/** The project chat: everything said to the coordinator, with a card for each thread it opened. */
export function ProjectChat({ me, className = "" }: { me: string; className?: string }) {
  const { project, members, names, state, send } = useProjectContext();
  const chat = projectChat(state);
  const roots = threadByRoot(state);
  const answers = decisionAnswers(chat);
  const thinking = !!state.active[""];

  return (
    <main className={cn("@container flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <PaneHeader>
        <NavToggle />
        <Hash size={17} className="flex-none text-muted" aria-hidden="true" />
        <h1 className="flex-none text-[15px] font-semibold">Project chat</h1>
        <span className="hidden truncate text-xs text-subtle sm:inline @max-[640px]:!hidden">{project.name}</span>
        <div className="ml-auto flex-none whitespace-nowrap">
          <WorkspaceButton project={project} />
        </div>
        <div className="ml-1 flex items-center @max-[520px]:hidden" aria-label={`${members.length} members`}>
          {members.slice(0, 4).map((m, i) => (
            <span key={m.id} title={m.name} className={i > 0 ? "-ml-2" : ""}>
              <UserAvatar id={m.id} name={m.name} size={26} className="border-2 border-ground" />
            </span>
          ))}
          {members.length > 4 && <span className="ml-1.5 text-xs text-subtle">+{members.length - 4}</span>}
        </div>
        <Link
          to="/settings/projects/$projectId"
          params={{ projectId: project.id }}
          aria-label="Project settings"
          title="Project settings"
          className="-mr-2 flex size-9 flex-none items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
        >
          <Settings size={16} />
        </Link>
      </PaneHeader>

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
          placeholder="Give Altair a task"
          onSend={(body, attachments) => send(body, null, attachments)}
          onUpload={(file) => api.upload(project.id, file.name, file)}
          autoFocus
        />
      </div>
    </main>
  );
}

function EmptyChat() {
  return (
    <div className="flex flex-col items-center gap-2 py-20 text-center">
      <span className="mb-2 flex size-12 items-center justify-center rounded-2xl border border-line bg-raised">
        <MessagesSquare size={22} className="text-muted" aria-hidden="true" />
      </span>
      <p className="text-base font-medium">What should Altair work on?</p>
      <p className="max-w-sm text-[13px] text-subtle">
        Ask for anything. Altair opens a thread for each piece of work and reports back there, so this chat stays
        readable.
      </p>
    </div>
  );
}
