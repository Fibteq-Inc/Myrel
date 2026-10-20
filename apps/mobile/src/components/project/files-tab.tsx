import { useI18n } from "@myrel/i18n/react";
import type { ProjectFile } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { type Href, useRouter } from "expo-router";
import { ChevronRight, FileText, FolderOpen } from "lucide-react-native";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { formatBytes } from "../../lib/format";
import { useProject } from "../../lib/project";
import { filesQueryKey } from "../../lib/queries";
import { useSession } from "../../lib/session";
import { colors, radius } from "../../theme";
import { errorMessage, Spinner, useRelativeTime } from "../ui";
import { Empty } from "./empty";

/** The project's shared files; tapping one previews it. */
export function FilesTab() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const relativeTime = useRelativeTime();
  const { api, server } = useSession();
  const { projectId } = useProject();
  const files = useQuery({
    queryKey: filesQueryKey(server, projectId),
    queryFn: () => api.listFiles(projectId),
  });

  if (files.isPending) {
    return (
      <View style={styles.center}>
        <Spinner size={22} color={colors.subtle} />
      </View>
    );
  }
  if (files.error) return <Empty title={errorMessage(files.error, t("common.error"))} />;

  return (
    <FlatList<ProjectFile>
      data={files.data}
      keyExtractor={(f) => f.path}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl refreshing={files.isRefetching} onRefresh={() => void files.refetch()} tintColor={colors.subtle} />
      }
      ListHeaderComponent={<Text style={styles.intro}>{t("knowledge.filesIntro")}</Text>}
      ListEmptyComponent={<Empty icon={<FolderOpen size={22} color={colors.subtle} />} title={t("knowledge.filesEmpty")} />}
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push(`/projects/${projectId}/file?path=${encodeURIComponent(item.path)}` as Href)}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.hover }]}
        >
          <FileText size={18} color={colors.muted} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={styles.name} numberOfLines={1}>
              {item.path}
            </Text>
            <Text style={styles.meta}>
              {formatBytes(item.size, locale)} · {relativeTime(item.updatedAt)}
            </Text>
          </View>
          <ChevronRight size={15} color={colors.subtle} />
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { padding: 16, gap: 8, flexGrow: 1 },
  intro: { color: colors.subtle, fontSize: 13, marginBottom: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.raised,
  },
  name: { color: colors.fg, fontSize: 14, fontWeight: "500" },
  meta: { color: colors.subtle, fontSize: 12 },
});
