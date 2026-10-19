import { threadMessages } from "@altair/client";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft, CircleCheck, LoaderCircle, PanelRightClose, PanelRightOpen, RotateCcw } from "lucide-react";
import { useState } from "react";
import {
  Checklist,
  Composer,
  decisionAnswers,
  MessageView,
  ScrollToEnd,
  Thinking,
  threadStatus,
  ThreadStatusIcon,
} from "../../../../../components/chat";
import { PaneHeader } from "../../../../../components/shell/shell";
import { defaultWorkspaceTabs, WorkspacePanel } from "../../../../../components/workspace/workspace-panel";
import { useProjectContext } from "../../../../../lib/project-context";
import { cn, GhostButton, IconButton } from "../../../../../lib/ui";

export const Route = createFileRoute("/_app/projects/$projectId/threads/$threadId")({
  component: ThreadView,
});

const PANEL_KEY = "altair.workspacePanel";

function readPanelPref() {
  try {
    return localStorage.getItem(PANEL_KEY) !== "closed";
  } catch {
    return true;
  }
}

/**
 * A thread, split: the conversation with its checklist on the left, the
 * workspace (changes, terminal, outputs) on the right. On narrow screens the
 * two take turns.
 */
function ThreadView() {
  const { threadId } = Route.useParams();
  const { user } = Route.useRouteContext();
  const { project, names, state, status, send, emit } = useProjectContext();
  const [panelOpen, setPanelOpen] = useState(readPanelPref);
  const [mobileView, setMobileView] = useState<"messages" | "workspace">("messages");

  const thread = state.threads[threadId];
  if (!thread) {
    const loading = status !== "open" || Object.keys(state.threads).length === 0;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-subtle">
        {loading ? (
          <LoaderCircle size={20} className="animate-spin" aria-label="Loading thread" />
        ) : (
          <>
            <p>This thread doesn't exist or was removed.</p>
            <Link to="/projects/$projectId" params={{ projectId: project.id }} className="text-[#b4beff] hover:underline">
              Back to the project chat
            </Link>
          </>
        )}
      </div>
    );
  }

  const root = state.messages.find((m) => m.id === thread.rootMessageId);
  const messages = threadMessages(state, thread.id);
  const answers = decisionAnswers(messages);
  const active = !!state.active[thread.id];
  const working = thread.status === "working" && !thread.resolved;
  const showChecklist = !!thread.statusText && !thread.resolved;

  function togglePanel() {
    if (window.matchMedia("(min-width: 1024px)").matches) {
      const next = !panelOpen;
      setPanelOpen(next);
      try {
        localStorage.setItem(PANEL_KEY, next ? "open" : "closed");
      } catch {
        // Private mode: the choice lasts until reload.
      }
    } else {
      setMobileView((v) => (v === "messages" ? "workspace" : "messages"));
    }
  }

  const panelShown = mobileView === "workspace" || panelOpen;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader className="gap-2 !px-3 sm:!px-4">
        <Link
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          aria-label="Back to the project chat"
          className="flex size-9 flex-none items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
        >
          <ChevronLeft size={18} />
        </Link>
        <ThreadStatusIcon thread={thread} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <h1 className="truncate text-[15px] font-semibold">{thread.title}</h1>
          <span className="hidden flex-none text-xs text-subtle sm:inline">{threadStatus(thread).label}</span>
        </div>
        <IconButton
          type="button"
          onClick={togglePanel}
          aria-label={panelShown ? "Hide workspace" : "Show workspace"}
          aria-pressed={panelShown}
          title={panelShown ? "Hide workspace" : "Show workspace"}
        >
          {panelShown ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
        </IconButton>
        {thread.resolved ? (
          <GhostButton type="button" onClick={() => emit({ type: "thread.resolve", threadId: thread.id, resolved: false })}>
            <RotateCcw size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Reopen</span>
          </GhostButton>
        ) : (
          <GhostButton type="button" onClick={() => emit({ type: "thread.resolve", threadId: thread.id, resolved: true })}>
            <CircleCheck size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Resolve</span>
          </GhostButton>
        )}
      </PaneHeader>

      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Thread messages"
          className={cn(
            "min-w-0 flex-1 flex-col",
            mobileView === "workspace" ? "hidden lg:flex" : "flex",
            panelOpen && "lg:max-w-[620px] lg:border-r lg:border-line",
          )}
        >
          {showChecklist && (
            <div className="max-h-[40%] flex-none overflow-y-auto border-b border-line bg-[#111114] px-5 py-3.5">
              <Checklist text={thread.statusText!} live={working} />
            </div>
          )}

          <ScrollToEnd dep={messages.length + (active ? 1 : 0)} className="flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-5 py-6">
              {root && <MessageView message={root} me={user.id} names={names} />}
              {messages.map((m) => (
                <MessageView
                  key={m.id}
                  message={m}
                  me={user.id}
                  names={names}
                  reactions={state.reactions[m.id]}
                  decision={{ answer: answers.get(m.id), onChoose: (label) => send(label, thread.id) }}
                />
              ))}
              {active && <Thinking label={working ? "Working" : "Thinking"} />}
            </div>
          </ScrollToEnd>

          <div className="mx-auto w-full max-w-[808px]">
            <Composer key={thread.id} placeholder="Reply in this thread" onSend={(body) => send(body, thread.id)} />
          </div>
        </section>

        <WorkspacePanel
          key={thread.id}
          tabs={defaultWorkspaceTabs(thread)}
          className={cn("flex-1", mobileView === "workspace" ? "flex" : "hidden", panelOpen ? "lg:flex" : "lg:hidden")}
        />
      </div>
    </div>
  );
}
