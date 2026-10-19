import type { Thread } from "@altair/protocol";
import { type Href, useRouter } from "expo-router";
import { ChevronRight, SquareTerminal } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, mono, radius } from "../theme";
import { threadActivity, ThreadStatusIcon } from "./thread-status";

/**
 * The card under a project-chat message that opened a thread: title, reply
 * count, and a live line with what the thread is doing right now.
 */
export function ThreadCard({ projectId, thread, replies }: { projectId: string; thread: Thread; replies: number }) {
  const router = useRouter();
  const activity = threadActivity(thread);
  const live = thread.status === "working" && !thread.resolved;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${thread.title}, ${activity.label}`}
      onPress={() => router.push(`/projects/${projectId}/threads/${thread.id}` as Href)}
      style={({ pressed }) => [styles.card, pressed && { borderColor: colors.edge, opacity: 0.85 }]}
    >
      <View style={styles.head}>
        <ThreadStatusIcon thread={thread} />
        <Text style={styles.title} numberOfLines={1}>
          {thread.title}
        </Text>
        <Text style={styles.replies}>{replies === 1 ? "1 reply" : `${replies} replies`}</Text>
        <ChevronRight size={15} color={colors.subtle} />
      </View>
      <View style={styles.foot}>
        {live && <SquareTerminal size={13} color={colors.subtle} />}
        <Text
          numberOfLines={1}
          style={[styles.activity, { color: activity.color }, live && { fontFamily: mono, color: colors.muted }]}
        >
          {activity.label}
        </Text>
        {live && <View style={styles.dot} />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "#26262b",
    backgroundColor: colors.raised,
    overflow: "hidden",
  },
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  title: { flex: 1, color: colors.fg, fontSize: 15, fontWeight: "600" },
  replies: { color: colors.subtle, fontSize: 12 },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: "#222227",
    backgroundColor: colors.panel,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  activity: { flex: 1, fontSize: 12 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
});
