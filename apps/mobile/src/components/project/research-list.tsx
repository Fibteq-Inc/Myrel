import type { MessageKey } from "@myrel/i18n";
import { useI18n } from "@myrel/i18n/react";
import type { ResearchSummary } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { type Href, useRouter } from "expo-router";
import { Search } from "lucide-react-native";
import type { ReactElement } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { formatCost } from "../../lib/format";
import { useProject } from "../../lib/project";
import { useSession } from "../../lib/session";
import { makeStyles, radius, useColors } from "../../theme";
import { useRelativeTime } from "../ui";
import { Empty } from "./empty";

/**
 * The threads tab's research view, as on the web: every research by Claude the project's threads
 * ran, newest first, with its state, spend against its budget and report, and this month's total.
 */
export function ResearchList({ header }: { header: ReactElement }) {
  const { t, locale } = useI18n();
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const relativeTime = useRelativeTime();
  const { projectId } = useProject();
  const { api } = useSession();
  const { data: research = [], isPending } = useQuery({
    queryKey: ["projects", projectId, "research"],
    queryFn: () => api.listResearch(projectId),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === "running" || r.status === "budget") ? 30_000 : false),
  });
  const usd = (cents: number) => formatCost(cents * 10_000, locale);
  const tone: Record<ResearchSummary["status"], string> = { running: colors.accent, budget: colors.warn, done: colors.ok, failed: colors.bad };
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = research.filter((r) => r.startedAt.startsWith(month));
  const total = thisMonth.reduce((sum, r) => sum + r.spentCents, 0);

  return (
    <FlatList<ResearchSummary>
      data={research}
      keyExtractor={(r) => r.id}
      contentContainerStyle={styles.list}
      ListHeaderComponent={header}
      ListEmptyComponent={isPending ? undefined : <Empty icon={<Search size={22} color={colors.subtle} />} title={t("research.empty")} />}
      ListFooterComponent={thisMonth.length > 0 ? <Text style={styles.total}>{t("research.monthTotal", { count: thisMonth.length, amount: usd(total) })}</Text> : undefined}
      renderItem={({ item: r }) => {
        const color = r.partial ? colors.warn : tone[r.status];
        const status = r.status === "done" && r.partial ? t(`research.partial.${r.partial}` as MessageKey) : t(`research.status.${r.status}` as MessageKey);
        return (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/projects/${projectId}/threads/${r.threadId}` as Href)}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.hover }]}
          >
            <View style={[styles.dot, { backgroundColor: color }]} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={styles.title} numberOfLines={1}>
                {r.title}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                <Text style={{ color }}>{status}</Text>
                {[r.threadTitle, r.approverName, relativeTime(r.startedAt)].filter(Boolean).map((part) => ` · ${part}`)}
              </Text>
            </View>
            <View style={{ alignItems: "flex-end", gap: 3 }}>
              <Text style={styles.amount}>
                {usd(r.spentCents)} / {usd(r.budgetCents)}
              </Text>
              {r.report ? (
                <Text
                  style={styles.link}
                  accessibilityRole="link"
                  onPress={() => router.push(`/projects/${projectId}/file?path=${encodeURIComponent(r.report!)}` as Href)}
                >
                  {t("research.report")}
                </Text>
              ) : (
                r.status !== "failed" && <Text style={styles.meta}>{t("research.inProgress")}</Text>
              )}
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
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      padding: 14,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.raised,
    },
    dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
    title: { color: colors.fg, fontSize: 15, fontWeight: "600" },
    meta: { color: colors.subtle, fontSize: 12 },
    amount: { color: colors.body, fontSize: 12, fontVariant: ["tabular-nums"] },
    link: { color: colors.link, fontSize: 12 },
    total: { color: colors.muted, fontSize: 13, marginTop: 6 },
  }),
);
