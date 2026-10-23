import { threadReplyCount } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { Thread } from "@myrel/protocol";
import { type Href, useRouter } from "expo-router";
import { ListTree } from "lucide-react-native";
import { useMemo } from "react";
import { Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import { useProject } from "../../lib/project";
import { makeStyles, radius, useColors } from "../../theme";
import { threadActivity, ThreadStatusIcon } from "../thread-status";
import { useRelativeTime } from "../ui";
import { Empty } from "./empty";

/** Every thread in the project: open ones first, most recently active on top. */
export function ThreadsTab() {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const relativeTime = useRelativeTime();
  const { projectId, state } = useProject();
  const sections = useMemo(() => {
    const all = Object.values(state.threads).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return [
      { key: "open", title: t("threads.open"), data: all.filter((th) => !th.resolved) },
      { key: "resolved", title: t("sidebar.resolved"), data: all.filter((th) => th.resolved) },
    ].filter((s) => s.data.length > 0);
  }, [state.threads, t]);

  if (sections.length === 0) {
    return <Empty icon={<ListTree size={22} color={colors.subtle} />} title={t("sidebar.noThreads")} />;
  }

  return (
    <SectionList<Thread>
      sections={sections}
      keyExtractor={(th) => th.id}
      contentContainerStyle={styles.list}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => <Text style={styles.section}>{section.title}</Text>}
      renderItem={({ item }) => {
        const activity = threadActivity(item, t, colors);
        return (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/projects/${projectId}/threads/${item.id}` as Href)}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.hover }]}
          >
            <View style={{ marginTop: 2 }}>
              <ThreadStatusIcon thread={item} />
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={styles.title} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={[styles.activity, { color: activity.color }]} numberOfLines={1}>
                {activity.label}
              </Text>
            </View>
            <View style={{ alignItems: "flex-end", gap: 3 }}>
              <Text style={styles.meta}>{relativeTime(item.updatedAt)}</Text>
              <Text style={styles.meta}>{t("threadCard.replies", { count: threadReplyCount(state, item.id) })}</Text>
            </View>
          </Pressable>
        );
      }}
    />
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    list: { padding: 16, gap: 8 },
    section: { color: colors.subtle, fontSize: 13, fontWeight: "600", marginTop: 8, marginBottom: 2 },
    row: {
      flexDirection: "row",
      gap: 12,
      padding: 14,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.raised,
    },
    title: { color: colors.fg, fontSize: 15, fontWeight: "600" },
    activity: { fontSize: 13 },
    meta: { color: colors.subtle, fontSize: 12 },
  }),
);
