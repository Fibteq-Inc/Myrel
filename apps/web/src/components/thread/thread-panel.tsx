import {
  conversationState,
  findMessage,
  threadMessages,
  threadPullRequests,
  threadSummary,
  threadTasks,
  threadUsage,
} from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import { CLOUD_RUNNER, decisionPicks, parsePlanUpdate, planChecklist, waitsForAgent } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChartColumn, CircleCheck, GitPullRequest, Maximize2, MessageSquareText, Minimize2, RotateCcw, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, projectSettingsQuery } from "../../lib/api";
import { useProjectContext } from "../../lib/project-context";
import { cn, IconButton } from "../../lib/ui";
import { ArtifactCards, ThreadOutputs } from "../artifacts";
import {
  ChatSkeleton,
  Composer,
  decisionAnswers,
  EarlierMessages,
  mentionedPullRequests,
  MessageView,
  PlanCard,
  PlanProgress,
  PlanUpdateNote,
  PullRequestCards,
  ScrollToEnd,
  Thinking,
  useHistoryWindow,
} from "../chat";
import { ThreadCliNote, ThreadCliPicker, ThreadModelPicker, ThreadRunnerNote, ThreadRunnerPicker, useOwnWorkspaces, usePickableClis } from "../chat/cli-picker";
import { ThreadUsageLabel } from "../chat/message-stats";
import { threadStatus, ThreadStatusIcon } from "../chat/thread-status";
import { withTasks } from "../workspace/tasks";
import { defaultWorkspaceTabs, EmptyTab, type WorkspaceTab } from "../workspace/workspace-panel";
import { CHAT_MIN, PANEL_MIN, useThreadPanel } from "./panel-state";
import { PullRequestsTab } from "./pull-requests-tab";
import { ThreadUsageTab } from "./thread-usage";

const CONVERSATION = "conversation";

/**
 * A thread as a panel on the right of the project chat. Drag its left edge
 * to resize, maximize it to take the whole area, close it to go back to the
 * chat. Tabs under its header switch between the conversation and what the
 * thread changed, opened, ran and produced. On phones it covers the screen.
 */
export function ThreadPanel({
  threadId,
  me,
  artifact,
  version,
  onOpenArtifact,
}: {
  threadId: string;
  me: string;
  /** The output open in the Outputs tab, from the URL. */
  artifact?: string;
  version?: number;
  onOpenArtifact: (artifact: string | undefined, version?: number) => void;
}) {
  const t = useT();
  const { project, state, status, ready, emit, loadTasks } = useProjectContext();
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

  useEffect(() => {
    // Earlier tasks and their output are not in the live sync; fetch them when the thread opens.
    if (status === "open") loadTasks(threadId).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, status]);

  const close = () => void navigate({ to: "/projects/$projectId", params: { projectId: project.id } });

  const thread = state.threads[threadId];
  const messages = thread ? threadMessages(state, thread.id) : [];
  const usage = thread ? threadUsage(state, thread.id) : null;
  // What this thread published, plus anything its messages delivered from elsewhere.
  const attached = new Set(messages.flatMap((m) => m.artifacts?.map((a) => a.artifactId) ?? []));
  const outputs = Object.values(state.artifacts)
    .filter((a) => a.threadId === threadId || attached.has(a.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const tabs = thread
    ? withTasks(
        defaultWorkspaceTabs(thread, t),
        { projectId: project.id, threadId: thread.id, tasks: threadTasks(state, thread.id), output: state.output },
        t,
      ).map((tab) =>
        tab.id === "outputs"
          ? {
              ...tab,
              count: outputs.length,
              content: (
                <ThreadOutputs
                  projectId={project.id}
                  thread={thread}
                  artifacts={outputs}
                  openId={artifact}
                  version={version}
                  onOpen={onOpenArtifact}
                />
              ),
            }
          : tab,
      )
    : [];
  if (thread) {
    const prs = threadPullRequests(state, thread.id);
    const pr: WorkspaceTab = {
      id: "pr",
      label: t("workspace.pr"),
      icon: GitPullRequest,
      count: prs.length || undefined,
      content: prs.length ? (
        <PullRequestsTab projectId={project.id} threadId={thread.id} pullRequests={prs} />
      ) : (
        <EmptyTab icon={GitPullRequest} title={t("workspace.prEmpty")}>
          {t("workspace.prEmptyBody")}
        </EmptyTab>
      ),
    };
    const at = tabs.findIndex((tab) => tab.id === "changes") + 1;
    tabs.splice(at, 0, pr);
    tabs.push({
      id: "usage",
      label: t("workspace.usage"),
      icon: ChartColumn,
      content: (
        <ThreadUsageTab
          projectId={project.id}
          threadId={thread.id}
          messages={messages}
          complete={!conversationState(state, thread.id).hasEarlier}
          version={JSON.stringify(thread.summary?.usage ?? null)}
        />
      ),
    });
  }
  const tool = tabs.some((tab) => tab.id === panel.tool) ? panel.tool : null;
  const current = tabs.find((tab) => tab.id === tool);
  const sections = [{ id: CONVERSATION, label: t("threadPanel.conversation"), icon: MessageSquareText, count: undefined }, ...tabs];

  // Opening an artifact brings the Outputs tab into view.
  useEffect(() => {
    if (artifact) openTool("outputs");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact]);

  function openTool(id: string) {
    panel.update({ tool: id === CONVERSATION ? null : id });
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
      aria-label={thread ? t("threadPanel.label", { title: thread.title }) : t("threadPanel.labelEmpty")}
      style={panel.maximized ? undefined : { width: panel.width, maxWidth: `calc(100% - ${CHAT_MIN}px)` }}
      className={cn(
        "relative flex min-w-0 flex-col border-line bg-sunken",
        "max-lg:fixed max-lg:inset-0 max-lg:z-30 max-lg:!w-auto max-lg:!max-w-none",
        panel.maximized ? "flex-1" : "flex-none lg:border-l",
      )}
    >
      {!panel.maximized && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("threadPanel.resize")}
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

      {/* Until the first sync is done, so a long thread opens at its end instead of scrolling there as pages arrive. */}
      {!thread || !ready ? (
        <PanelMissing loading={!ready} onClose={close} />
      ) : (
        <>
          <header className="flex h-14 flex-none items-center gap-1 border-b border-line pl-4 pr-2">
            <ThreadStatusIcon thread={thread} />
            <div className="ml-1.5 flex min-w-0 flex-1 flex-col leading-tight">
              <h2 className="truncate text-[14px] font-semibold">{thread.title}</h2>
              <span className="flex min-w-0 items-center gap-1.5 text-[11px]">
                <span className={cn("truncate", threadStatus(thread, t).tone)}>{threadStatus(thread, t).label}</span>
                {usage && usage.tokens > 0 && (
                  <>
                    <span aria-hidden="true" className="text-edge-strong">
                      ·
                    </span>
                    <ThreadUsageLabel usage={usage} />
                  </>
                )}
              </span>
            </div>

            <div
              role="tablist"
              aria-label={t("threadPanel.tools")}
              className="mr-1 flex flex-none items-center gap-0.5 rounded-lg border border-line p-0.5"
            >
              {sections.map((tab, i) => {
                const selected = (tool ?? CONVERSATION) === tab.id;
                const label = tab.count ? `${tab.label} (${tab.count})` : tab.label;
                return (
                  <button
                    key={tab.id}
                    id={`thread-tab-${tab.id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls="thread-tabpanel"
                    aria-label={label}
                    tabIndex={selected ? 0 : -1}
                    title={label}
                    onClick={() => openTool(tab.id)}
                    onKeyDown={(e) => {
                      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                      e.preventDefault();
                      const next = sections[(i + (e.key === "ArrowRight" ? 1 : -1) + sections.length) % sections.length]!;
                      openTool(next.id);
                      document.getElementById(`thread-tab-${next.id}`)?.focus();
                    }}
                    className={cn(
                      "relative flex h-7 flex-none items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                      selected ? "bg-hover text-fg max-sm:w-7 sm:gap-1.5 sm:pl-2 sm:pr-2.5" : "w-7 text-muted hover:bg-hover hover:text-fg",
                    )}
                  >
                    <tab.icon size={15} aria-hidden="true" className="flex-none" />
                    {selected ? (
                      <span aria-hidden="true" className="hidden max-w-[9rem] truncate text-[13px] font-medium sm:inline">
                        {tab.label}
                        {tab.count ? <span className="ml-1 font-mono text-xs text-muted">{tab.count}</span> : null}
                      </span>
                    ) : null}
                    {tab.count ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "absolute -right-1 -top-1 min-w-3.5 rounded-full bg-raised px-[3px] text-center font-mono text-[9px] leading-[14px] text-muted ring-1 ring-line",
                          selected && "sm:hidden",
                        )}
                      >
                        {tab.count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            <IconButton
              type="button"
              onClick={() => emit({ type: "thread.resolve", threadId: thread.id, resolved: !thread.resolved })}
              aria-label={thread.resolved ? t("threadPanel.reopen") : t("threadPanel.resolve")}
              title={thread.resolved ? t("threadPanel.reopen") : t("threadPanel.resolve")}
              className="size-8"
            >
              {thread.resolved ? <RotateCcw size={16} /> : <CircleCheck size={16} />}
            </IconButton>
            <IconButton
              type="button"
              onClick={() => panel.update({ maximized: !panel.maximized })}
              aria-label={panel.maximized ? t("threadPanel.restore") : t("threadPanel.maximize")}
              title={panel.maximized ? t("threadPanel.restore") : t("threadPanel.maximize")}
              className="size-8 max-lg:!hidden"
            >
              {panel.maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </IconButton>
            <IconButton
              type="button"
              onClick={close}
              aria-label={t("threadPanel.close")}
              title={t("threadPanel.close")}
              className="size-8"
            >
              <X size={17} />
            </IconButton>
          </header>

          <div id="thread-tabpanel" role="tabpanel" aria-labelledby={`thread-tab-${tool ?? CONVERSATION}`} className="flex min-h-0 flex-1">
            {/* The conversation stays mounted so a half-written reply survives a look at another tab. */}
            <Conversation
              key={thread.id}
              threadId={thread.id}
              me={me}
              wide={measured > 900}
              openArtifact={artifact}
              className={current ? "hidden" : "flex"}
            />
            {current && <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-sunken">{current.content}</div>}
          </div>
        </>
      )}
    </aside>
  );
}

function Conversation({
  threadId,
  me,
  wide,
  openArtifact,
  className = "",
}: {
  threadId: string;
  me: string;
  wide: boolean;
  openArtifact?: string;
  className?: string;
}) {
  const t = useT();
  const { project, names, state, status, send, emit, loadConversation } = useProjectContext();
  const thread = state.threads[threadId]!;
  // A thread the first sync did not bring (it brings only the project chat) is fetched when opened.
  const held = conversationState(state, thread.id);
  useEffect(() => {
    if (!held.loaded && status === "open") loadConversation(thread.id).catch(() => {});
  }, [held.loaded, thread.id, status, loadConversation]);
  const pickable = usePickableClis(project, thread.runner?.id);
  const ownWorkspaces = useOwnWorkspaces(project);
  // A project that always works in the cloud has nothing to place.
  const placeable = useQuery(projectSettingsQuery(project.id)).data?.taskTarget !== "cloud";
  const root = findMessage(state, thread.rootMessageId);
  const messages = threadMessages(state, thread.id);
  const history = useHistoryWindow(messages, {
    hasEarlier: held.hasEarlier,
    load: () => loadConversation(thread.id, messages[0]?.seq),
  });
  const answers = decisionAnswers(messages);
  // A tap on a card is shown on the card itself, not again as a bubble.
  const picks = decisionPicks(messages);
  const choose = useCallback((label: string) => send(label, threadId), [send, threadId]);
  // Each pull request shows under the message that links it; one no message linked yet shows at the end.
  const pullRequests = threadPullRequests(state, thread.id);
  const unmentioned = pullRequests.filter((pr) => !messages.some((m) => m.body.includes(pr.url)));
  const active = !!state.active[thread.id];
  const last = messages.at(-1);
  const working = thread.status === "working" && !thread.resolved;
  // Messages the working agent has not taken in yet: the newest says so, with a way to send them now.
  const waiting = messages.findLast((m) => waitsForAgent(m, thread));
  // The newest plan card is the one the agent is moving along; the thread's checklist is its freshest state.
  const currentPlan = threadSummary(state, thread.id).planMessageId;
  const planAnchor = (id: string) => `plan-${id}`;
  const [planOpen, setPlanOpen] = useState(false);
  return (
    <section aria-label={t("thread.messages")} className={cn("min-w-0 flex-1 flex-col", className)}>
      {/* Stays once the work is done, so the finished plan is still one click away. */}
      {thread.statusText && (
        <div className="flex-none border-b border-line bg-panel px-5 py-2.5">
          <PlanProgress
            key={thread.id}
            planKey={`${thread.id}\n${thread.statusText.split("\n", 1)[0]}`}
            text={thread.statusText}
            live={working}
            open={planOpen}
            onOpenChange={setPlanOpen}
            onJump={
              currentPlan
                ? () => document.getElementById(planAnchor(currentPlan))?.scrollIntoView({ behavior: "smooth", block: "start" })
                : undefined
            }
          />
        </div>
      )}
      <ScrollToEnd
        // Brought to the end once the thread's messages arrive, even when the newest came in live before.
        last={held.loaded ? last?.id : undefined}
        busy={active}
        mine={last?.authorKind === "user" && last.authorId === me}
        className="flex-1 overflow-y-auto"
      >
        {!held.loaded ? (
          // The thread's shape while its newest messages load, at the bottom where they will be.
          <div className={cn("mx-auto flex h-full w-full flex-col justify-end overflow-hidden px-5 py-6", wide ? "max-w-[760px]" : "")}>
            <ChatSkeleton />
          </div>
        ) : (
          <div className={cn("mx-auto flex w-full flex-col gap-6 px-5 py-6", wide ? "max-w-[760px]" : "")}>
            {root && !history.more && (
              <MessageView
                message={root}
                me={me}
                names={names}
                reactions={state.reactions[root.id]}
                onEdit={(body) => emit({ type: "message.edit", messageId: root.id, body })}
              />
            )}
            {!history.more && <ThreadRunnerNote thread={thread} />}
            {!history.more && <ThreadCliNote thread={thread} />}
            <EarlierMessages hidden={history.hidden} more={history.more} loading={history.loading} onShow={history.showEarlier} />
            {history.visible.map((m) => {
              if (picks.has(m.id)) return null;
              const plan = m.authorKind === "agent" ? planChecklist(m.body) : null;
              if (plan !== null) {
                const current = m.id === currentPlan;
                return (
                  <PlanCard
                    key={m.id}
                    id={planAnchor(m.id)}
                    text={current && thread.statusText ? thread.statusText : plan}
                    live={current && working}
                  />
                );
              }
              const update = m.authorKind === "agent" ? parsePlanUpdate(m.body) : null;
              if (update) {
                return (
                  <PlanUpdateNote key={m.id} update={update} onOpenPlan={thread.statusText ? () => setPlanOpen(true) : undefined} />
                );
              }
              return (
                <MessageView
                  key={m.id}
                  message={m}
                  me={me}
                  names={names}
                  reactions={state.reactions[m.id]}
                  decision={{ answer: answers.get(m.id), onChoose: choose }}
                  onEdit={(body) => emit({ type: "message.edit", messageId: m.id, body })}
                  onInterrupt={m.id === waiting?.id ? () => api.interruptThread(project.id, thread.id) : undefined}
                >
                  {m.artifacts?.length ? (
                    <ArtifactCards
                      projectId={project.id}
                      threadId={thread.id}
                      refs={m.artifacts}
                      artifacts={state.artifacts}
                      openId={openArtifact}
                    />
                  ) : null}
                  {m.authorKind === "agent" && <PullRequestCards pullRequests={mentionedPullRequests(m.body, pullRequests)} />}
                </MessageView>
              );
            })}
            <PullRequestCards pullRequests={unmentioned} />
            {active && (
              <Thinking
                label={state.progress[thread.id] ?? (working ? t("message.working") : t("message.thinking"))}
                onStop={() => api.stopThread(project.id, thread.id)}
              />
            )}
          </div>
        )}
      </ScrollToEnd>
      <div className={cn("mx-auto w-full", wide ? "max-w-[808px]" : "")}>
        <Composer
          key={thread.id}
          placeholder={t("thread.placeholder")}
          onSend={(body, attachments) => send(body, thread.id, attachments)}
          onUpload={(file) => api.upload(project.id, file.name, file)}
          tools={
            pickable && (
              <>
                {/* The cloud or a computer, for someone with the project on one of theirs (else their turns work in the cloud anyway). */}
                {placeable && (ownWorkspaces.length > 0 || thread.runner?.id === CLOUD_RUNNER) && (
                  <ThreadRunnerPicker
                    workspaces={ownWorkspaces}
                    thread={thread}
                    onChange={(runnerId) => emit({ type: "thread.runner", threadId: thread.id, runnerId })}
                  />
                )}
                <ThreadCliPicker
                  pickable={pickable}
                  thread={thread}
                  onChange={(cli) => emit({ type: "thread.cli", threadId: thread.id, cli })}
                />
                <ThreadModelPicker
                  pickable={pickable}
                  thread={thread}
                  onChange={(pick) => emit({ type: "thread.model", threadId: thread.id, ...pick })}
                />
              </>
            )
          }
        />
      </div>
    </section>
  );
}

function PanelMissing({ loading, onClose }: { loading: boolean; onClose: () => void }) {
  const t = useT();
  if (loading) {
    // The thread's shape while it loads: its header, then the newest messages at the bottom.
    return (
      <>
        <div aria-hidden="true" className="flex h-14 flex-none animate-pulse items-center gap-2.5 border-b border-line px-4">
          <div className="size-4 rounded-full bg-bubble" />
          <div className="flex flex-col gap-1.5">
            <div className="h-3 w-48 rounded bg-bubble" />
            <div className="h-2 w-20 rounded bg-bubble" />
          </div>
        </div>
        <div className="flex flex-1 flex-col justify-end overflow-hidden px-5 py-6">
          <ChatSkeleton />
        </div>
      </>
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-subtle">
      <p>{t("thread.missing")}</p>
      <button type="button" onClick={onClose} className="text-link hover:underline">
        {t("thread.backToChat")}
      </button>
    </div>
  );
}

