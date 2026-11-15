import { checkLabelStatus } from "@myrel/client";
import type { MessageKey } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import type { Thread } from "@myrel/protocol";
import { type Href, useRouter } from "expo-router";
import { ChevronRight, ScanEye, SquareTerminal } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { makeStyles, mono, radius, useColors } from "../theme";
import { threadActivity, ThreadStatusIcon } from "./thread-status";

/**
 * The card under a project-chat message that opened a thread: title, reply
 * count, and a live line with what the thread is doing right now.
 */
export function ThreadCard({
  projectId,
  thread,
  replies,
  checks = [],
}: {
  projectId: string;
  thread: Thread;
  replies: number;
  /** Threads Myrel opened to check this one's work (visual checks), shown indented under it. */
  checks?: Thread[];
}) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const activity = threadActivity(thread, t, colors);
  const live = thread.status === "working" && !thread.resolved;
  const card = (
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
        <Text style={styles.replies}>{t("threadCard.replies", { count: replies })}</Text>
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
  if (!checks.length) return card;
  return (
    <View>
      {card}
      <ChildThreads projectId={projectId} threads={checks} />
    </View>
  );
}

/** The visual check rounds of a thread, indented under it and joined to it by a line, as on the web. */
export function ChildThreads({ projectId, threads }: { projectId: string; threads: Thread[] }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const tone: Record<string, string> = { running: colors.accent, passed: colors.ok, failed: colors.bad, partial: colors.warn, not_checked: colors.warn };
  return (
    <View style={styles.children}>
      {threads.map((c) => {
        const status = checkLabelStatus(c) ?? (c.resolved ? "not_checked" : "running");
        return (
          <Pressable
            key={c.id}
            accessibilityRole="button"
            onPress={() => router.push(`/projects/${projectId}/threads/${c.id}` as Href)}
            style={({ pressed }) => [styles.child, pressed && { opacity: 0.85 }]}
          >
            <ScanEye size={14} color={colors.muted} />
            <Text style={styles.childTitle} numberOfLines={1}>
              {c.title}
            </Text>
            <Text style={[styles.childStatus, { color: tone[status] ?? colors.muted }]}>{t(`visualCheck.status.${status}` as MessageKey)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    card: {
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.card,
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
      borderTopColor: colors.divider,
      backgroundColor: colors.panel,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    activity: { flex: 1, fontSize: 12 },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
    children: { marginLeft: 20, marginTop: 6, gap: 6, borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: 12 },
    child: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.card,
      backgroundColor: colors.panel,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    childTitle: { flex: 1, color: colors.fg, fontSize: 14 },
    childStatus: { fontSize: 12, fontWeight: "600" },
  }),
);
