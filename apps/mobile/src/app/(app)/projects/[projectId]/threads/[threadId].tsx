import { threadMessages } from "@altair/client";
import { Stack, useLocalSearchParams } from "expo-router";
import { ChevronDown, ChevronUp, CircleCheck, RotateCcw } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Checklist } from "../../../../../components/checklist";
import { Conversation } from "../../../../../components/conversation";
import { ThreadStatusIcon, threadStatus } from "../../../../../components/thread-status";
import { useProject } from "../../../../../lib/project";
import { useSession } from "../../../../../lib/session";
import { colors } from "../../../../../theme";
import { useNames } from "../../../../../lib/use-names";

export default function ThreadScreen() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const { user } = useSession();
  const { projectId, state, send, emit } = useProject();
  const names = useNames(projectId);
  const thread = state.threads[threadId];
  const [checklistOpen, setChecklistOpen] = useState(true);

  // The message that opened the thread leads the conversation.
  const messages = useMemo(() => {
    const root = thread && state.messages.find((m) => m.id === thread.rootMessageId);
    const replies = threadMessages(state, threadId);
    return root ? [root, ...replies] : replies;
  }, [state, thread, threadId]);
  const onSend = useCallback((body: string) => send(body, threadId), [send, threadId]);

  const live = thread?.status === "working" && !thread.resolved;
  const header = thread?.statusText && !thread.resolved ? (
    <View style={styles.panel}>
      {checklistOpen ? (
        <Checklist text={thread.statusText} live={live} />
      ) : (
        <Text style={styles.collapsed} numberOfLines={1}>
          {threadStatus(thread).label}
        </Text>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={checklistOpen ? "Hide progress" : "Show progress"}
        hitSlop={8}
        onPress={() => setChecklistOpen((v) => !v)}
        style={styles.toggle}
      >
        {checklistOpen ? <ChevronUp size={16} color={colors.subtle} /> : <ChevronDown size={16} color={colors.subtle} />}
      </Pressable>
    </View>
  ) : null;

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
              <Text style={styles.titleText}>Thread</Text>
            ),
          headerRight: () =>
            thread ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={thread.resolved ? "Reopen thread" : "Mark resolved"}
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
        working={!!state.active[threadId]}
        placeholder="Reply in this thread"
        onSend={onSend}
        header={header}
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
    paddingTop: 12,
    paddingBottom: 14,
    paddingRight: 40,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.panel,
  },
  collapsed: { color: colors.subtle, fontSize: 13 },
  toggle: { position: "absolute", right: 14, top: 12 },
});
