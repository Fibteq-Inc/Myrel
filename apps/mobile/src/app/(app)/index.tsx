import { useI18n, useT } from "@myrel/i18n/react";
import type { Project } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Href, Stack, useRouter } from "expo-router";
import { ChevronRight, FolderClosed, Plus, Settings } from "lucide-react-native";
import { useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Button, errorMessage, Input, Spinner, useRelativeTime } from "../../components/ui";
import { formatCost } from "../../lib/format";
import { useSession } from "../../lib/session";
import { colors, radius } from "../../theme";

export default function ProjectsScreen() {
  const t = useT();
  const relativeTime = useRelativeTime();
  const { api, server } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  // Polled so each row's live activity stays current while the list is open.
  const projects = useQuery({ queryKey: ["projects", server], queryFn: () => api.listProjects(), refetchInterval: 15_000 });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: (projectName: string) => api.createProject({ name: projectName }),
    onSuccess: (project) => {
      setCreating(false);
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["projects", server] });
      router.push(`/projects/${project.id}` as Href);
    },
  });

  return (
    <>
      <Stack.Screen
        options={{
          title: t("projects.title"),
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 18 }}>
              <Pressable accessibilityLabel={t("mobile.newProject")} hitSlop={10} onPress={() => setCreating((v) => !v)}>
                <Plus size={22} color={colors.fg} />
              </Pressable>
              <Pressable accessibilityLabel={t("settings.title")} hitSlop={10} onPress={() => router.push("/settings")}>
                <Settings size={20} color={colors.subtle} />
              </Pressable>
            </View>
          ),
        }}
      />
      <FlatList<Project>
        contentInsetAdjustmentBehavior="automatic"
        data={projects.data ?? []}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={projects.isRefetching}
            onRefresh={() => void projects.refetch()}
            tintColor={colors.subtle}
          />
        }
        ListHeaderComponent={
          creating ? (
            <View style={styles.create}>
              <Input
                value={name}
                onChangeText={setName}
                placeholder={t("projects.name")}
                autoFocus
                autoCapitalize="sentences"
                returnKeyType="done"
                onSubmitEditing={() => name.trim() && create.mutate(name.trim())}
              />
              {create.error && <Text style={styles.error}>{errorMessage(create.error, t("common.error"))}</Text>}
              <Button onPress={() => create.mutate(name.trim())} pending={create.isPending} disabled={!name.trim()}>
                {t("projects.create")}
              </Button>
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          projects.isPending ? (
            <View style={styles.empty}>
              <Spinner size={22} color={colors.subtle} />
            </View>
          ) : projects.error ? (
            <View style={styles.empty}>
              <Text style={styles.error}>{errorMessage(projects.error, t("common.error"))}</Text>
              <Button variant="ghost" onPress={() => void projects.refetch()}>
                {t("mobile.retry")}
              </Button>
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{t("projects.start")}</Text>
              <Text style={styles.emptyHint}>{t("projects.intro")}</Text>
              <Button onPress={() => setCreating(true)}>{t("mobile.newProject")}</Button>
            </View>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/projects/${item.id}` as Href)}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.hover }]}
          >
            <View style={styles.icon}>
              <FolderClosed size={18} color={colors.accent} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.meta}>
                {item.role === "owner" ? t("projects.owner") : t("projects.member")} · {relativeTime(item.createdAt)}
              </Text>
              <ProjectActivity project={item} />
            </View>
            <ProjectCost project={item} />
            <ChevronRight size={16} color={colors.subtle} />
          </Pressable>
        )}
      />
    </>
  );
}

/** What is going on in the project right now; nothing when it is idle. */
function ProjectActivity({ project }: { project: Project }) {
  const t = useT();
  const working = project.activity?.working ?? 0;
  const waiting = project.activity?.waiting ?? 0;
  if (!working && !waiting) return null;
  return (
    <View style={styles.activity}>
      {working > 0 && (
        <View style={styles.activityItem}>
          <View style={[styles.dot, { backgroundColor: colors.accent }]} />
          <Text style={[styles.activityText, { color: colors.accent }]} numberOfLines={1}>
            {t("projects.working", { count: working })}
          </Text>
        </View>
      )}
      {waiting > 0 && (
        <View style={styles.activityItem}>
          <View style={[styles.dot, { backgroundColor: colors.warn }]} />
          <Text style={[styles.activityText, { color: colors.warn }]} numberOfLines={1}>
            {t("projects.waiting", { count: waiting })}
          </Text>
        </View>
      )}
    </View>
  );
}

/** This month's model cost, quiet beside the chevron; nothing until a call is priced. */
function ProjectCost({ project }: { project: Project }) {
  const t = useT();
  const { locale } = useI18n();
  if (!project.cost?.totalMicros) return null;
  const month = formatCost(project.cost.monthMicros, locale);
  return (
    <Text
      style={styles.cost}
      accessibilityLabel={`${t("projects.costMonth", { cost: month })}, ${t("projects.costTotal", { cost: formatCost(project.cost.totalMicros, locale) })}`}
    >
      {month}
    </Text>
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 8, flexGrow: 1 },
  create: { gap: 10, marginBottom: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.raised,
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { color: colors.fg, fontSize: 16, fontWeight: "600" },
  meta: { color: colors.subtle, fontSize: 13 },
  activity: { flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 2, marginTop: 2 },
  activityItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  activityText: { fontSize: 13, fontWeight: "500" },
  cost: { color: colors.subtle, fontSize: 13, fontVariant: ["tabular-nums"] },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingVertical: 48 },
  emptyTitle: { color: colors.fg, fontSize: 18, fontWeight: "600" },
  emptyHint: { color: colors.subtle, fontSize: 14, lineHeight: 20, textAlign: "center", paddingHorizontal: 24 },
  error: { color: colors.bad, fontSize: 14 },
});
