import { useI18n } from "@myrel/i18n/react";
import { USAGE_RANGES } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { formatCost, formatTokens, modelName } from "../../lib/format";
import { useProject } from "../../lib/project";
import { useSession } from "../../lib/session";
import { colors, radius } from "../../theme";
import { errorMessage, Spinner } from "../ui";
import { Empty } from "./empty";
import { Tabs } from "./tabs";

type Range = (typeof USAGE_RANGES)[number];

/** What this project's agents spent: totals, by model, and the costliest threads. */
export function UsageTab() {
  const { t, locale } = useI18n();
  const { api, server } = useSession();
  const { projectId } = useProject();
  const [days, setDays] = useState<Range>(30);
  const usage = useQuery({
    queryKey: ["usage", server, projectId, days],
    queryFn: () => api.getUsage({ days, projectId, tzOffset: new Date().getTimezoneOffset() }),
  });
  const data = usage.data;
  const tokens = (n: number) => formatTokens(n, locale);

  return (
    <View style={{ flex: 1 }}>
      <Tabs
        label={t("usage.range")}
        tabs={USAGE_RANGES.map((d) => ({ key: String(d), label: t("usage.rangeDays", { count: d }) }))}
        value={String(days)}
        onChange={(k) => setDays(Number(k) as Range)}
      />
      {usage.isPending ? (
        <View style={styles.center}>
          <Spinner size={22} color={colors.subtle} />
        </View>
      ) : usage.error || !data ? (
        <Empty title={errorMessage(usage.error, t("common.error"))} />
      ) : data.totals.calls === 0 ? (
        <Empty title={t("usage.emptyRange")} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.page}
          refreshControl={
            <RefreshControl refreshing={usage.isRefetching} onRefresh={() => void usage.refetch()} tintColor={colors.subtle} />
          }
        >
          <View style={styles.grid}>
            <Stat label={t("usage.cost")} value={formatCost(data.totals.costMicros, locale)} />
            <Stat
              label={t("usage.tokens")}
              value={tokens(data.totals.inputTokens + data.totals.outputTokens)}
              hint={t("usage.inOut", { input: tokens(data.totals.inputTokens), output: tokens(data.totals.outputTokens) })}
            />
            <Stat label={t("usage.calls")} value={String(data.totals.calls)} />
            <Stat
              label={t("usage.cached")}
              value={tokens(data.totals.cachedInputTokens)}
            />
          </View>

          {data.byModel.length > 0 && (
            <Section title={t("usage.byModel")}>
              {data.byModel.map((m) => (
                <Line
                  key={`${m.provider}/${m.model}`}
                  name={modelName(m.model)}
                  value={formatCost(m.costMicros, locale)}
                  hint={t("usage.modelCalls", { count: m.calls })}
                />
              ))}
            </Section>
          )}

          <Section title={t("usage.topThreads")}>
            {data.topThreads.length === 0 ? (
              <Text style={styles.hint}>{t("usage.noThreadWork")}</Text>
            ) : (
              data.topThreads.map((th) => (
                <Line
                  key={th.threadId}
                  name={th.title}
                  value={formatCost(th.costMicros, locale)}
                  hint={t("stats.tokens", { tokens: tokens(th.inputTokens + th.outputTokens) })}
                />
              ))
            )}
          </Section>
        </ScrollView>
      )}
    </View>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      {hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.section}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Line({ name, value, hint }: { name: string; value: string; hint: string }) {
  return (
    <View style={styles.line}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.lineName} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.hint}>{hint}</Text>
      </View>
      <Text style={styles.lineValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  page: { padding: 16, gap: 20 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  stat: {
    flexGrow: 1,
    flexBasis: "45%",
    gap: 4,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.raised,
  },
  statLabel: { color: colors.subtle, fontSize: 12 },
  statValue: { color: colors.fg, fontSize: 20, fontWeight: "600" },
  hint: { color: colors.subtle, fontSize: 12 },
  section: { color: colors.subtle, fontSize: 13, fontWeight: "600" },
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.raised,
    paddingHorizontal: 14,
  },
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  lineName: { color: colors.fg, fontSize: 14 },
  lineValue: { color: colors.body, fontSize: 14, fontVariant: ["tabular-nums"] },
});
