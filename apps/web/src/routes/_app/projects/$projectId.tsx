import { projectChat, threadByRoot, threadMessages, threadTasks } from "@altair/client";
import type { Message, Task, TerminalLine, Thread } from "@altair/protocol";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft, MessagesSquare, RotateCcw, CircleCheck, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { Checklist, Composer, MessageView, type Names, Thinking, ThreadCard, threadStatus } from "../../../components/chat";
import { TaskPanel } from "../../../components/tasks";
import { membersQuery, projectQuery } from "../../../lib/api";
import { GhostButton } from "../../../lib/ui";
import { useProject } from "../../../lib/use-project";

type Search = { thread?: string };

export const Route = createFileRoute("/_app/projects/$projectId")({
  validateSearch: (search: Record<string, unknown>): Search =>
    typeof search.thread === "string" ? { thread: search.thread } : {},
  loader: ({ context, params }) => context.queryClient.ensureQueryData(projectQuery(params.projectId)),
  component: ProjectPage,
});

function ProjectPage() {
  const { projectId } = Route.useParams();
  const { thread: openThreadId } = Route.useSearch();
  const { user } = Route.useRouteContext();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: members = [] } = useQuery(membersQuery(projectId));
  const names: Names = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m.name])), [members]);
  const { state, status, send, emit, loadTasks } = useProject(projectId);
  useEffect(() => {
    // Earlier tasks and their output are not in the live sync; fetch them when a thread opens.
    if (openThreadId && status === "open") loadTasks(openThreadId).catch(() => {});
  }, [openThreadId, status]);

  const chat = projectChat(state);
  const roots = threadByRoot(state);
  const openThread = openThreadId ? state.threads[openThreadId] : undefined;
  const replyCount = (threadId: string) => threadMessages(state, threadId).length;

  return (
    <div className="flex min-h-0 flex-1">
      <main className={`min-w-0 flex-1 flex-col ${openThread ? "hidden lg:flex" : "flex"}`}>
        <header className="flex h-14 flex-none items-center gap-3 border-b border-line px-4 sm:px-5">
          <Link to="/" aria-label="All projects" className="-ml-1 rounded-lg p-1 text-muted hover:bg-hover md:hidden">
            <ChevronLeft size={18} />
          </Link>
          <MessagesSquare size={17} className="text-muted" aria-hidden="true" />
          <h1 className="truncate text-[15px] font-semibold">{project.name}</h1>
          <ConnectionDot status={status} />
        </header>

        <ScrollToEnd dep={chat.length + (state.active[""] ? 1 : 0)} className="flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-7 px-4 py-7 sm:px-6">
            {chat.length === 0 && <EmptyChat />}
            {chat.map((m) => {
              const thread = roots.get(m.id);
              return (
                <MessageView key={m.id} message={m} me={user.id} names={names} reactions={state.reactions[m.id]}>
                  {thread && (
                    <ThreadCard
                      projectId={projectId}
                      thread={thread}
                      replies={replyCount(thread.id)}
                      open={thread.id === openThreadId}
                    />
                  )}
                </MessageView>
              );
            })}
            {state.active[""] && <Thinking />}
          </div>
        </ScrollToEnd>

        <div className="mx-auto w-full max-w-[800px]">
          <Composer placeholder="Message the project" onSend={(body) => send(body)} />
        </div>
      </main>

      {openThread && (
        <ThreadPanel
          projectId={projectId}
          thread={openThread}
          root={state.messages.find((m) => m.id === openThread.rootMessageId)}
          messages={threadMessages(state, openThread.id)}
          tasks={threadTasks(state, openThread.id)}
          output={state.output}
          active={!!state.active[openThread.id]}
          me={user.id}
          names={names}
          onSend={(body) => send(body, openThread.id)}
          onResolve={(resolved) => emit({ type: "thread.resolve", threadId: openThread.id, resolved })}
        />
      )}
    </div>
  );
}

function ThreadPanel({
  projectId,
  thread,
  root,
  messages,
  tasks,
  output,
  active,
  me,
  names,
  onSend,
  onResolve,
}: {
  projectId: string;
  thread: Thread;
  root?: Message;
  messages: Message[];
  tasks: Task[];
  output: Record<string, TerminalLine[]>;
  active: boolean;
  me: string;
  names: Names;
  onSend: (body: string) => void;
  onResolve: (resolved: boolean) => void;
}) {
  const status = threadStatus(thread);
  const showChecklist = thread.statusText && (thread.status === "working" || thread.status === "blocked");
  return (
    <section
      aria-label={`Thread: ${thread.title}`}
      className="flex min-w-0 flex-1 flex-col border-l border-line bg-[#0c0c0e] lg:max-w-[600px]"
    >
      <header className="flex h-14 flex-none items-center gap-2.5 border-b border-line px-4">
        <span aria-hidden="true">{status.icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold">{thread.title}</h2>
        </div>
        {thread.resolved ? (
          <GhostButton type="button" onClick={() => onResolve(false)}>
            <RotateCcw size={14} aria-hidden="true" />
            Reopen
          </GhostButton>
        ) : (
          <GhostButton type="button" onClick={() => onResolve(true)}>
            <CircleCheck size={14} aria-hidden="true" />
            Resolve
          </GhostButton>
        )}
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          search={{}}
          aria-label="Close thread"
          className="flex size-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
        >
          <X size={17} />
        </Link>
      </header>

      {showChecklist && (
        <div className="flex-none border-b border-line bg-panel px-5 py-3.5">
          <Checklist text={thread.statusText!} />
        </div>
      )}

      <TaskPanel projectId={projectId} tasks={tasks} output={output} />

      <ScrollToEnd dep={messages.length + (active ? 1 : 0)} className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 px-5 py-6">
          {root && <MessageView message={root} me={me} names={names} />}
          {messages.map((m) => (
            <MessageView key={m.id} message={m} me={me} names={names} />
          ))}
          {active && <Thinking label={thread.status === "working" ? "Working" : "Thinking"} />}
        </div>
      </ScrollToEnd>

      <Composer placeholder="Reply in this thread" onSend={onSend} />
    </section>
  );
}

function ScrollToEnd({ dep, className, children }: { dep: number; className: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return (
    <div
      ref={ref}
      className={className}
      onScroll={(e) => {
        const el = e.currentTarget;
        // Keep following new messages only while the reader is at the bottom.
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {children}
    </div>
  );
}

function ConnectionDot({ status }: { status: string }) {
  const color = status === "open" ? "bg-ok" : status === "connecting" ? "bg-warn" : "bg-bad";
  const label = status === "open" ? "Live" : status === "connecting" ? "Connecting" : "Offline";
  return (
    <span className="ml-auto flex items-center gap-2 text-xs text-subtle" title={label}>
      <span aria-hidden="true" className={`size-2 rounded-full ${color}`} />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

function EmptyChat() {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <MessagesSquare size={28} className="text-subtle" aria-hidden="true" />
      <p className="font-medium">Ask for anything</p>
      <p className="max-w-sm text-[13px] text-subtle">
        Altair opens a thread for each piece of work and answers there, so this chat stays readable.
      </p>
    </div>
  );
}
