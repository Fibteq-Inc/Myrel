import { threadMessages } from "@altair/client";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, CircleCheck, LoaderCircle, Maximize2, Minimize2, RotateCcw, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useProjectContext } from "../../lib/project-context";
import { cn, IconButton } from "../../lib/ui";
import { Checklist, Composer, decisionAnswers, MessageView, ScrollToEnd, Thinking } from "../chat";
import { threadStatus, ThreadStatusIcon } from "../chat/thread-status";
import { defaultWorkspaceTabs, WorkspacePanel } from "../workspace/workspace-panel";
import { CHAT_MIN, PANEL_MIN, PANEL_SPLIT, useThreadPanel } from "./panel-state";

/** Below this panel width a workspace tab takes the conversation's place instead of sitting beside it. */
const SIDE_BY_SIDE = 700;

/**
 * A thread as a panel on the right of the project chat. Drag its left edge
 * to resize, maximize it to take the whole area, close it to go back to the
 * chat. Its header opens the workspace tools (changes, terminal, outputs)
 * beside the conversation. On phones it covers the screen.
 */
export function ThreadPanel({ threadId, me }: { threadId: string; me: string }) {
  const { project, state, status, emit } = useProjectContext();
  const panel = useThreadPanel();
  const navigate = useNavigate();
  const ref = useRef<HTMLElement>(null);
  const [measured, setMeasured] = useState(panel.width);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setMeasured(entry!.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const close = () => void navigate({ to: "/projects/$projectId", params: { projectId: project.id } });

  const thread = state.threads[threadId];
  const tabs = thread ? defaultWorkspaceTabs(thread) : [];
  const tool = tabs.some((t) => t.id === panel.tool) ? panel.tool : null;
  const sideBySide = measured >= SIDE_BY_SIDE;

  function openTool(id: string) {
    if (tool === id) return panel.update({ tool: null });
    // Make room for the conversation and the tool side by side.
    panel.update({ tool: id, ...(!panel.maximized && panel.width < PANEL_SPLIT ? { width: PANEL_SPLIT } : {}) });
  }

  function startResize(e: ReactPointerEvent<HTMLDivElement>) {
    const el = ref.current;
    const container = el?.parentElement;
    if (!el || !container) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = el.getBoundingClientRect().width;
    const max = container.getBoundingClientRect().width - CHAT_MIN;
    const onMove = (ev: PointerEvent) => {
      const width = Math.round(Math.min(max, Math.max(PANEL_MIN, startWidth + startX - ev.clientX)));
      panel.update({ width, maximized: false });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <aside
      ref={ref}
      aria-label={thread ? `Thread: ${thread.title}` : "Thread"}
      style={panel.maximized ? undefined : { width: panel.width, maxWidth: `calc(100% - ${CHAT_MIN}px)` }}
      className={cn(
        "relative flex min-w-0 flex-col border-line bg-[#0c0c0e]",
        "max-lg:fixed max-lg:inset-0 max-lg:z-30 max-lg:!w-auto max-lg:!max-w-none",
        panel.maximized ? "flex-1" : "flex-none lg:border-l",
      )}
    >
      {!panel.maximized && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize thread panel"
          aria-valuenow={Math.round(measured)}
          tabIndex={0}
          onPointerDown={startResize}
          onDoubleClick={() => panel.update({ maximized: true })}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const step = e.key === "ArrowLeft" ? 40 : -40;
            panel.update({ width: Math.max(PANEL_MIN, panel.width + step) });
          }}
          className="group absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize lg:block"
        >
          <span className="absolute inset-y-0 left-[3px] w-0.5 bg-transparent transition-colors group-hover:bg-accent/60 group-focus-visible:bg-accent" />
        </div>
      )}

      {!thread ? (
        <PanelMissing loading={status !== "open" || Object.keys(state.threads).length === 0} onClose={close} />
      ) : (
        <>
          <header className="flex h-14 flex-none items-center gap-1 border-b border-line pl-4 pr-2">
            <ThreadStatusIcon thread={thread} />
            <div className="ml-1.5 flex min-w-0 flex-1 flex-col leading-tight">
              <h2 className="truncate text-[14px] font-semibold">{thread.title}</h2>
              <span className={cn("truncate text-[11px]", threadStatus(thread).tone)}>{threadStatus(thread).label}</span>
            </div>

            <div role="group" aria-label="Workspace tools" className="flex items-center gap-0.5 rounded-lg border border-line p-0.5">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => openTool(t.id)}
                  aria-pressed={tool === t.id}
                  aria-label={t.label}
                  title={t.label}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md transition-colors",
                    tool === t.id ? "bg-hover text-fg" : "text-muted hover:bg-hover hover:text-fg",
                  )}
                >
                  <t.icon size={15} />
                </button>
              ))}
            </div>

            <IconButton
              type="button"
              onClick={() => emit({ type: "thread.resolve", threadId: thread.id, resolved: !thread.resolved })}
              aria-label={thread.resolved ? "Reopen thread" : "Mark resolved"}
              title={thread.resolved ? "Reopen thread" : "Mark resolved"}
              className="size-8"
            >
              {thread.resolved ? <RotateCcw size={16} /> : <CircleCheck size={16} />}
            </IconButton>
            <IconButton
              type="button"
              onClick={() => panel.update({ maximized: !panel.maximized })}
              aria-label={panel.maximized ? "Restore panel size" : "Maximize panel"}
              title={panel.maximized ? "Restore panel size" : "Maximize panel"}
              className="size-8 max-lg:!hidden"
            >
              {panel.maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </IconButton>
            <IconButton type="button" onClick={close} aria-label="Close thread" title="Close thread" className="size-8">
              <X size={17} />
            </IconButton>
          </header>

          <div className="flex min-h-0 flex-1">
            {(!tool || sideBySide) && (
              <Conversation threadId={thread.id} me={me} wide={!tool && measured > 900} />
            )}
            {tool && (
              <div className={cn("flex min-w-0 flex-col", sideBySide ? "w-[52%] flex-none border-l border-line" : "flex-1")}>
                {!sideBySide && (
                  <button
                    type="button"
                    onClick={() => panel.update({ tool: null })}
                    className="flex h-9 flex-none items-center gap-1.5 border-b border-line px-4 text-[13px] text-muted hover:text-fg"
                  >
                    <ArrowLeft size={14} aria-hidden="true" />
                    Back to the conversation
                  </button>
                )}
                <WorkspacePanel
                  key={thread.id}
                  tabs={tabs}
                  active={tool}
                  onActiveChange={(id) => panel.update({ tool: id })}
                  onClose={() => panel.update({ tool: null })}
                  className="flex min-h-0 flex-1"
                />
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function Conversation({ threadId, me, wide }: { threadId: string; me: string; wide: boolean }) {
  const { project, names, state, send } = useProjectContext();
  const thread = state.threads[threadId]!;
  const root = state.messages.find((m) => m.id === thread.rootMessageId);
  const messages = threadMessages(state, thread.id);
  const answers = decisionAnswers(messages);
  const active = !!state.active[thread.id];
  const working = thread.status === "working" && !thread.resolved;
  return (
    <section aria-label="Thread messages" className="flex min-w-0 flex-1 flex-col">
      {thread.statusText && !thread.resolved && (
        <div className="max-h-[40%] flex-none overflow-y-auto border-b border-line bg-[#111114] px-5 py-3.5">
          <Checklist text={thread.statusText} live={working} />
        </div>
      )}
      <ScrollToEnd dep={messages.length + (active ? 1 : 0)} className="flex-1 overflow-y-auto">
        <div className={cn("mx-auto flex w-full flex-col gap-6 px-5 py-6", wide ? "max-w-[760px]" : "")}>
          {root && <MessageView message={root} me={me} names={names} />}
          {messages.map((m) => (
            <MessageView
              key={m.id}
              message={m}
              me={me}
              names={names}
              reactions={state.reactions[m.id]}
              decision={{ answer: answers.get(m.id), onChoose: (label) => send(label, thread.id) }}
            />
          ))}
          {active && <Thinking label={state.progress[thread.id] ?? (working ? "Working" : "Thinking")} />}
        </div>
      </ScrollToEnd>
      <div className={cn("mx-auto w-full", wide ? "max-w-[808px]" : "")}>
        <Composer
          key={thread.id}
          placeholder="Reply in this thread"
          onSend={(body, attachments) => send(body, thread.id, attachments)}
          onUpload={(file) => api.upload(project.id, file.name, file)}
        />
      </div>
    </section>
  );
}

function PanelMissing({ loading, onClose }: { loading: boolean; onClose: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-subtle">
      {loading ? (
        <LoaderCircle size={20} className="animate-spin" aria-label="Loading thread" />
      ) : (
        <>
          <p>This thread doesn't exist or was removed.</p>
          <button type="button" onClick={onClose} className="text-[#b4beff] hover:underline">
            Back to the project chat
          </button>
        </>
      )}
    </div>
  );
}

