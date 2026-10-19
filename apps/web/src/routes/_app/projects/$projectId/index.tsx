import { projectChat, threadByRoot, threadMessages } from "@altair/client";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Hash, MessagesSquare, Settings } from "lucide-react";
import { WorkspaceButton } from "../../../../components/local-folder";
import { ArtifactCards } from "../../../../components/artifacts";
import { Composer, decisionAnswers, MessageView, ScrollToEnd, Thinking, ThreadCard } from "../../../../components/chat";
import { NavToggle, PaneHeader } from "../../../../components/shell/shell";
import { useProjectContext } from "../../../../lib/project-context";
import { api } from "../../../../lib/api";
import { UserAvatar } from "../../../../lib/ui";

export const Route = createFileRoute("/_app/projects/$projectId/")({
  // Older links opened a thread with ?thread=.
  validateSearch: (search: Record<string, unknown>): { thread?: string } =>
    typeof search.thread === "string" ? { thread: search.thread } : {},
  beforeLoad: ({ params, search }) => {
    if (search.thread) {
      throw redirect({ to: "/projects/$projectId/threads/$threadId", params: { ...params, threadId: search.thread } });
    }
  },
  component: ProjectChat,
});

function ProjectChat() {
  const { user } = Route.useRouteContext();
  const { project, members, names, state, send } = useProjectContext();
  const chat = projectChat(state);
  const roots = threadByRoot(state);
  const answers = decisionAnswers(chat);
  const thinking = !!state.active[""];

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PaneHeader>
        <NavToggle />
        <Hash size={17} className="flex-none text-muted" aria-hidden="true" />
        <h1 className="truncate text-[15px] font-semibold">Project chat</h1>
        <span className="hidden truncate text-xs text-subtle sm:inline">{project.name}</span>
        <div className="ml-auto">
          <WorkspaceButton project={project} />
        </div>
        <div className="ml-1 flex items-center" aria-label={`${members.length} members`}>
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
                me={user.id}
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
