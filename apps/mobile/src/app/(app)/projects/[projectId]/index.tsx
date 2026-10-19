import { projectChat, threadByRoot, threadMessages } from "@altair/client";
import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useCallback, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Conversation } from "../../../../components/conversation";
import { ThreadCard } from "../../../../components/thread-card";
import { useProject } from "../../../../lib/project";
import { useSession } from "../../../../lib/session";
import { colors } from "../../../../theme";
import { useNames } from "../../../../lib/use-names";

export default function ProjectChatScreen() {
  const { api, server, user } = useSession();
  const { projectId, state, status, send } = useProject();
  const project = useQuery({ queryKey: ["projects", server, projectId], queryFn: () => api.getProject(projectId) });
  const names = useNames(projectId);
  const messages = useMemo(() => projectChat(state), [state]);
  const threads = useMemo(() => threadByRoot(state), [state]);
  const onSend = useCallback((body: string) => send(body, null), [send]);

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={styles.title}>
              <Text style={styles.titleText} numberOfLines={1}>
                {project.data?.name ?? "Project"}
              </Text>
              {status !== "open" && <Text style={styles.status}>{status === "connecting" ? "Connecting…" : "Offline"}</Text>}
            </View>
          ),
        }}
      />
      <Conversation
        messages={messages}
        me={user?.id ?? ""}
        names={names}
        reactions={state.reactions}
        working={!!state.active[""]}
        placeholder="Message the project"
        onSend={onSend}
        footerFor={(m) => {
          const thread = threads.get(m.id);
          if (!thread) return null;
          return <ThreadCard projectId={projectId} thread={thread} replies={threadMessages(state, thread.id).length} />;
        }}
        empty={
          status === "open" ? (
            <View style={{ alignItems: "center", gap: 6, paddingHorizontal: 24 }}>
              <Text style={styles.emptyTitle}>Start the conversation</Text>
              <Text style={styles.emptyHint}>Ask for something and Altair opens a thread to work on it.</Text>
            </View>
          ) : null
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  title: { alignItems: "center" },
  titleText: { color: colors.fg, fontSize: 17, fontWeight: "600", maxWidth: 240 },
  status: { color: colors.subtle, fontSize: 12 },
  emptyTitle: { color: colors.fg, fontSize: 18, fontWeight: "600" },
  emptyHint: { color: colors.subtle, fontSize: 14, textAlign: "center" },
});
