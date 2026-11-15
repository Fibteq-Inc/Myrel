import { threadChildren, threadReplyCount } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { Thread } from "@myrel/protocol";
import { type Href, useRouter } from "expo-router";
import { ListTree } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import { useProject } from "../../lib/project";
import { makeStyles, radius, useColors } from "../../theme";
import { ChildThreads } from "../thread-card";
import { threadActivity, ThreadStatusIcon } from "../thread-status";
import { useRelativeTime } from "../ui";
import { Empty } from "./empty";
import { ResearchList } from "./research-list";

/** Every thread in the project: open ones first, most recently active on top. */
export function ThreadsTab() {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const relativeTime = useRelativeTime();
  const { projectId, state } = useProject();
  const [view, setView] = useState<"threads" | "research">("threads");
  // A visual check's evaluator is listed under the thread it checks, not on its own.
  const checks = useMemo(() => threadChildren(state), [state]);
  const sections = useMemo(() => {
    const all = Object.values(state.threads)
      .filter((th) => !th.parentId || !state.threads[th.parentId])
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return [
      { key: "open", title: t("threads.open"), data: all.filter((th) => !th.resolved) },
      { key: "resolved", title: t("sidebar.resolved"), data: all.filter((th) => th.resolved) },
    ].filter((s) => s.data.length > 0);
  }, [state.threads, t]);

  // Threads or the project's researches, like the web's switch at the top of the tab.
  const toggle = (
    <View style={styles.toggle} accessibilityRole="tablist">
      {(["threads", "research"] as const).map((v) => (
        <Pressable
          key={v}
          accessibilityRole="tab"
          accessibilityState={{ selected: view === v }}
          onPress={() => setView(v)}
          style={[styles.toggleItem, view === v && { backgroundColor: colors.bubble }]}
        >
          <Text style={[styles.toggleText, { color: view === v ? colors.fg : colors.muted }]}>{t(`research.view.${v}`)}</Text>
        </Pressable>
      ))}
    </View>
  );

  if (view === "research") return <ResearchList header={toggle} />;

  if (sections.length === 0) {
    return (
      <View style={{ flex: 1 }}>
        <View style={styles.list}>{toggle}</View>
        <Empty icon={<ListTree size={22} color={colors.subtle} />} title={t("sidebar.noThreads")} />
      </View>
    );
  }

  return (
    <SectionList<Thread>
      sections={sections}
      ListHeaderComponent={toggle}
      keyExtractor={(th) => th.id}
      contentContainerStyle={styles.list}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => <Text style={styles.section}>{section.title}</Text>}
      renderItem={({ item }) => {
        const activity = threadActivity(item, t, colors);
        const rounds = checks.get(item.id);
        return (
          <View>
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
            {rounds && <ChildThreads projectId={projectId} threads={rounds} />}
          </View>
        );
      }}
    />
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    list: { padding: 16, gap: 8 },
    toggle: { flexDirection: "row", alignSelf: "flex-start", borderWidth: 1, borderColor: colors.edge, borderRadius: radius.md, padding: 2 },
    toggleItem: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: radius.sm },
    toggleText: { fontSize: 14 },
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
