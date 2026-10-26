import {
  conversationState,
  findMessage,
  threadMessages,
  threadPullRequests,
  threadSummary,
  threadTasks,
  threadUsage,
} from "@myrel/client";
import { useI18n, useT } from "@myrel/i18n/react";
import { CLOUD_RUNNER, waitsForAgent } from "@myrel/protocol";
import { Stack, useLocalSearchParams } from "expo-router";
import { CircleCheck, RotateCcw } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PlanProgress } from "../../../../../components/checklist";
import {
  ThreadCliNote,
  ThreadCliPicker,
  ThreadModelPicker,
  ThreadRunnerNote,
  ThreadRunnerPicker,
  useOwnWorkspaces,
  usePickableClis,
  usePlaceable,
} from "../../../../../components/cli-picker";
import { Conversation } from "../../../../../components/conversation";
import { Tabs } from "../../../../../components/project/tabs";
import { WorkspaceFilesTab } from "../../../../../components/thread/files";
import { OutputsTab } from "../../../../../components/thread/outputs";
import { PullRequestsTab } from "../../../../../components/thread/pull-requests";
import { ChangesTab, TerminalTab } from "../../../../../components/thread/tasks";
import { ThreadUsageTab } from "../../../../../components/thread/usage";
import { ThreadStatusIcon } from "../../../../../components/thread-status";
import { formatCost, formatTokens } from "../../../../../lib/format";
import { useProject } from "../../../../../lib/project";
import { useSession } from "../../../../../lib/session";
import { makeStyles, useColors } from "../../../../../theme";
import { useNames } from "../../../../../lib/use-names";

type Tab = "conversation" | "changes" | "pr" | "terminal" | "files" | "outputs" | "usage";

/**
 * A thread: its conversation and, as on the web, the tabs for what it changed, the pull requests it
 * opened, what it ran, what its cloud tasks saved, what it published and what it cost. The tabs sit
 * in a strip under the header that scrolls sideways when they don't fit the phone's width.
 */
export default function ThreadScreen() {
  const colors = useColors();
  const styles = useStyles();
  const t = useT();
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const { user, api } = useSession();
  const { projectId, state, status, ready, send, emit, loadTasks, loadConversation } = useProject();
  const names = useNames(projectId);
  const thread = state.threads[threadId];
  const { locale } = useI18n();
  const usage = thread ? threadUsage(state, threadId) : null;
  const usageText =
    usage && usage.tokens > 0
      ? [t("stats.tokens", { tokens: formatTokens(usage.tokens, locale) }), usage.costMicros ? formatCost(usage.costMicros, locale) : null]
          .filter(Boolean)
          .join(" · ")
      : null;

  // A thread the first sync did not bring (it brings only the project chat) is fetched when opened.
  const held = conversationState(state, threadId);
  useEffect(() => {
    if (ready && !held.loaded && status === "open") loadConversation(threadId).catch(() => {});
  }, [ready, held.loaded, threadId, status, loadConversation]);
  const replies = threadMessages(state, threadId);
  // The message that opened the thread leads the conversation, once it is scrolled back to.
  const messages = useMemo(() => {
    const root = thread && !held.hasEarlier ? findMessage(state, thread.rootMessageId) : undefined;
    return root ? [root, ...replies] : replies;
  }, [state, thread, held.hasEarlier, replies]);
  // Messages the working agent has not taken in yet: the newest says so, with a way to send them now.
  const waiting = thread ? messages.findLast((m) => waitsForAgent(m, thread)) : undefined;
  const onSend = useCallback(
    (body: string, attachments?: string[]) => send(body, threadId, attachments),
    [send, threadId],
  );

  // Earlier tasks and their output are not in the live sync; fetch them when the thread opens.
  useEffect(() => {
    if (status === "open") loadTasks(threadId).catch(() => {});
  }, [status, threadId, loadTasks]);
  const [tab, setTab] = useState<Tab>("conversation");
  const tasks = useMemo(() => threadTasks(state, threadId), [state, threadId]);
  const pullRequests = useMemo(() => threadPullRequests(state, threadId), [state, threadId]);
  // What this thread published, plus anything its messages delivered from elsewhere.
  const outputs = useMemo(() => {
    const attached = new Set(messages.flatMap((m) => m.artifacts?.map((a) => a.artifactId) ?? []));
    return Object.values(state.artifacts)
      .filter((a) => a.threadId === threadId || attached.has(a.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [state.artifacts, messages, threadId]);
  // Cloud tasks save their work in the thread's workspace; tasks on a computer work in its own folder.
  const sandbox = tasks.some((task) => task.backend === "sandbox");
  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "conversation", label: t("threadPanel.conversation") },
    { key: "changes", label: t("workspace.changes"), count: tasks.filter((task) => task.prUrl).length || undefined },
    { key: "pr", label: t("workspace.pr"), count: pullRequests.length || undefined },
    { key: "terminal", label: t("workspace.terminal"), count: tasks.length || undefined },
    ...(sandbox ? [{ key: "files" as const, label: t("files.workspace") }] : []),
    { key: "outputs", label: t("workspace.outputs"), count: outputs.length || undefined },
    { key: "usage", label: t("workspace.usage") },
  ];
  const current = tabs.some((x) => x.key === tab) ? tab : "conversation";

  const live = thread?.status === "working" && !thread.resolved;
  const [planOpen, setPlanOpen] = useState(false);
  // The progress line is pinned and opens the whole plan in place; the plan card stays where the work
  // started. It stays once the work is done, so the finished plan is still one tap away.
  const progress = thread?.statusText ? (
    <View style={styles.panel}>
      <PlanProgress
        key={threadId}
        planKey={`${threadId}\n${thread.statusText.split("\n", 1)[0]}`}
        text={thread.statusText}
        live={live}
        open={planOpen}
        onOpenChange={setPlanOpen}
      />
    </View>
  ) : null;
  // Which CLI Myrel picked, or that it opened the thread in the cloud, and why, stays in view above the conversation.
  const header =
    progress || thread?.cli?.by === "coordinator" || thread?.runner?.by === "coordinator" ? (
      <>
        {progress}
        {thread && <ThreadRunnerNote thread={thread} />}
        {thread && <ThreadCliNote thread={thread} />}
      </>
    ) : null;
  const pickable = usePickableClis(projectId, thread?.runner?.id);
  const ownWorkspaces = useOwnWorkspaces(projectId);
  const placeable = usePlaceable(projectId);
  // The newest plan card is the one the agent is moving along; the thread's checklist is its freshest state.
  const currentPlan = threadSummary(state, threadId).planMessageId;
  const plan =
    currentPlan && thread?.statusText ? { messageId: currentPlan, text: thread.statusText, live } : undefined;

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () =>
            thread ? (
              <View style={styles.title}>
                <ThreadStatusIcon thread={thread} />
                <View style={styles.titleLines}>
                  <Text style={styles.titleText} numberOfLines={1}>
                    {thread.title}
                  </Text>
                  {usageText && (
                    <Text style={styles.usage} numberOfLines={1}>
                      {usageText}
                    </Text>
                  )}
                </View>
              </View>
            ) : (
              <Text style={styles.titleText}>{t("thread.loading")}</Text>
            ),
          headerRight: () =>
            thread ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={thread.resolved ? t("thread.reopen") : t("thread.resolve")}
                hitSlop={10}
                onPress={() => emit({ type: "thread.resolve", threadId, resolved: !thread.resolved })}
                style={styles.resolve}
              >
                {thread.resolved ? (
                  <RotateCcw size={18} color={colors.fg} />
                ) : (
                  <CircleCheck size={18} color={colors.fg} />
                )}
              </Pressable>
            ) : null,
        }}
      />
      <Tabs<Tab> label={t("threadPanel.tools")} value={current} onChange={setTab} tabs={tabs} />
      {/* The conversation stays mounted so a half-written reply survives a look at another tab. */}
      <View style={current === "conversation" ? styles.fill : styles.hidden}>
        <Conversation
          threadId={threadId}
          messages={messages}
          loading={!ready || !held.loaded}
          hasEarlier={held.hasEarlier}
          onLoadEarlier={() => loadConversation(threadId, replies[0]?.seq)}
          me={user?.id ?? ""}
          names={names}
          reactions={state.reactions}
          artifacts={state.artifacts}
          projectId={projectId}
          working={state.active[threadId] ? (state.progress[threadId] ?? t("message.working")) : null}
          placeholder={t("thread.placeholder")}
          onSend={onSend}
          onEdit={(messageId, body) => emit({ type: "message.edit", messageId, body })}
          onInterrupt={waiting && { messageId: waiting.id, run: () => api.interruptThread(projectId, threadId) }}
          header={header}
          tools={
            pickable &&
            thread && (
              <>
                {/* The cloud or a computer, for someone with the project on one of theirs (else their turns work in the cloud anyway). */}
                {placeable && (ownWorkspaces.length > 0 || thread.runner?.id === CLOUD_RUNNER) && (
                  <ThreadRunnerPicker workspaces={ownWorkspaces} thread={thread} onChange={(runnerId) => emit({ type: "thread.runner", threadId, runnerId })} />
                )}
                <ThreadCliPicker pickable={pickable} thread={thread} onChange={(cli) => emit({ type: "thread.cli", threadId, cli })} />
                <ThreadModelPicker pickable={pickable} thread={thread} onChange={(pick) => emit({ type: "thread.model", threadId, ...pick })} />
              </>
            )
          }
          plan={plan}
          onOpenPlan={thread?.statusText ? () => setPlanOpen(true) : undefined}
        />
      </View>
      {current === "changes" ? (
        <ChangesTab tasks={tasks} />
      ) : current === "pr" ? (
        <PullRequestsTab pullRequests={pullRequests} />
      ) : current === "terminal" ? (
        <TerminalTab projectId={projectId} tasks={tasks} output={state.output} />
      ) : current === "files" ? (
        <WorkspaceFilesTab projectId={projectId} threadId={threadId} tasks={tasks} />
      ) : current === "outputs" ? (
        <OutputsTab projectId={projectId} artifacts={outputs} />
      ) : current === "usage" ? (
        <ThreadUsageTab
          projectId={projectId}
          threadId={threadId}
          messages={messages}
          complete={!held.hasEarlier}
          version={JSON.stringify(thread?.summary?.usage ?? null)}
        />
      ) : null}
    </>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    fill: { flex: 1 },
    hidden: { display: "none" },
    title: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 240 },
    titleLines: { flexShrink: 1 },
    titleText: { color: colors.fg, fontSize: 17, fontWeight: "600", flexShrink: 1 },
    usage: { color: colors.subtle, fontSize: 11, fontVariant: ["tabular-nums"] },
    resolve: {
      width: 36,
      height: 36,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.edge,
      alignItems: "center",
      justifyContent: "center",
    },
    panel: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
      backgroundColor: colors.panel,
    },
  }),
);
