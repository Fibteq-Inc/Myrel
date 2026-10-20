import { threadMessages } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import { planChecklist } from "@myrel/protocol";
import { Stack, useLocalSearchParams } from "expo-router";
import { CircleCheck, RotateCcw } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PlanProgress } from "../../../../../components/checklist";
import { Conversation } from "../../../../../components/conversation";
import { ThreadStatusIcon } from "../../../../../components/thread-status";
import { useProject } from "../../../../../lib/project";
import { useSession } from "../../../../../lib/session";
import { colors } from "../../../../../theme";
import { useNames } from "../../../../../lib/use-names";

export default function ThreadScreen() {
  const t = useT();
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const { user } = useSession();
  const { projectId, state, send, emit } = useProject();
  const names = useNames(projectId);
  const thread = state.threads[threadId];

  // The message that opened the thread leads the conversation.
  const messages = useMemo(() => {
    const root = thread && state.messages.find((m) => m.id === thread.rootMessageId);
    const replies = threadMessages(state, threadId);
    return root ? [root, ...replies] : replies;
  }, [state, thread, threadId]);
  const onSend = useCallback((body: string) => send(body, threadId), [send, threadId]);

  const live = thread?.status === "working" && !thread.resolved;
  // Only the progress line is pinned; the full list is the plan card in the conversation.
  const header = thread?.statusText && !thread.resolved ? (
    <View style={styles.panel}>
      <PlanProgress text={thread.statusText} live={live} />
    </View>
  ) : null;
  // The newest plan card is the one the agent is moving along; the thread's checklist is its freshest state.
  const currentPlan = messages.findLast((m) => m.authorKind === "agent" && planChecklist(m.body) !== null);
  const plan =
    currentPlan && thread?.statusText ? { messageId: currentPlan.id, text: thread.statusText, live } : undefined;

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () =>
            thread ? (
              <View style={styles.title}>
                <ThreadStatusIcon thread={thread} />
                <Text style={styles.titleText} numberOfLines={1}>
                  {thread.title}
                </Text>
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
      <Conversation
        messages={messages}
        me={user?.id ?? ""}
        names={names}
        reactions={state.reactions}
        artifacts={state.artifacts}
        projectId={projectId}
        working={state.active[threadId] ? (state.progress[threadId] ?? t("message.working")) : null}
        placeholder={t("thread.placeholder")}
        onSend={onSend}
        header={header}
        plan={plan}
      />
    </>
  );
}

const styles = StyleSheet.create({
  title: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 240 },
  titleText: { color: colors.fg, fontSize: 17, fontWeight: "600", flexShrink: 1 },
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
});
