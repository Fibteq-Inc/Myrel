import { chartSlot, DEFAULT_USAGE_FILTER, localDay, USAGE_CLIS, USAGE_METRICS, USAGE_PRESETS, type UsageFilter, type UsageMetric, usageQuery, usageSeries } from "@myrel/client";
import type { MessageKey } from "@myrel/i18n";
import { useI18n } from "@myrel/i18n/react";
import { COORDINATOR_HARNESS, UNKNOWN_HARNESS, type UsageSummary, usageSpeed } from "@myrel/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { formatCost, formatDuration, formatNumber, formatSpeed, formatTokens, modelName } from "../../lib/format";
import { useProjectId } from "../../lib/project";
import { useSession } from "../../lib/session";
import { makeStyles, radius, useColors } from "../../theme";
import { Option, Sheet } from "../cli-picker";
import { harnessName } from "../message-stats";
import { CliMark, errorMessage, Spinner } from "../ui";
import { DateRange } from "./date-range";
import { Empty } from "./empty";
import { Tabs } from "./tabs";
import { seriesColor, UsageChart } from "./usage-chart";

type Picking = "cli" | "runtime" | "scope" | "dates";
const METRIC_LABEL: Record<UsageMetric, MessageKey> = { tokens: "usage.tokens", turns: "usage.turns", time: "usage.time", cost: "usage.costShort" };

/** What this project's agents did and spent, filtered like the web's: totals, days, by CLI and model, and the costliest threads. */
export function UsageTab() {
  const { t } = useI18n();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const projectId = useProjectId();
  const [filter, setFilter] = useState<UsageFilter>(DEFAULT_USAGE_FILTER);
  const [picking, setPicking] = useState<Picking | null>(null);
  const usage = useQuery({
    queryKey: ["usage", server, projectId, filter],
    queryFn: () => api.getUsage(usageQuery({ ...filter, project: projectId })),
    placeholderData: keepPreviousData,
  });
  const data = usage.data;
  const name = useHarnessLabel();
  const today = localDay(new Date());
  const change = (next: Partial<UsageFilter>) => setFilter((f) => ({ ...f, ...next }));
  const pickRange = (range: UsageFilter["range"]) => {
    change({ range, ...(range === "custom" && !filter.from && { from: localDay(new Date(Date.now() - 6 * 86_400_000)), to: today }) });
    if (range === "custom") setPicking("dates");
  };
  const choose = (next: Partial<UsageFilter>) => {
    change(next);
    setPicking(null);
  };

  return (
    <View style={{ flex: 1 }}>
      <Tabs
        label={t("usage.range")}
        tabs={USAGE_PRESETS.map((p) => ({
          key: p,
          label: p === "1" ? t("usage.rangeToday") : p === "month" ? t("usage.rangeMonth") : p === "custom" ? t("usage.rangeCustom") : t("usage.rangeDays", { count: Number(p) }),
        }))}
        value={filter.range}
        onChange={pickRange}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 0 }} contentContainerStyle={styles.filters}>
        <Filter label={filter.cli ? name(filter.cli) : t("usage.allClis")} title={t("usage.cli")} onPress={() => setPicking("cli")} />
        <Filter label={t(filter.runtime ? `usage.${filter.runtime}` : "usage.anywhere")} title={t("usage.where")} onPress={() => setPicking("runtime")} />
        <Filter label={t(filter.scope === "mine" ? "usage.mine" : "usage.everyone")} title={t("usage.scope")} onPress={() => setPicking("scope")} />
      </ScrollView>
      <Sheet open={picking === "cli"} onClose={() => setPicking(null)} title={t("usage.cli")}>
        <ScrollView style={{ maxHeight: 420 }}>
          <Option kind="radio" checked={!filter.cli} title={t("usage.allClis")} onPress={() => choose({ cli: undefined })} />
          {USAGE_CLIS.map((c) => (
            <Option key={c} kind="radio" checked={filter.cli === c} title={name(c)} cli={c} onPress={() => choose({ cli: c })} />
          ))}
        </ScrollView>
      </Sheet>
      <Sheet open={picking === "runtime"} onClose={() => setPicking(null)} title={t("usage.where")}>
        <Option kind="radio" checked={!filter.runtime} title={t("usage.anywhere")} onPress={() => choose({ runtime: undefined })} />
        <Option kind="radio" checked={filter.runtime === "local"} title={t("usage.local")} onPress={() => choose({ runtime: "local" })} />
        <Option kind="radio" checked={filter.runtime === "cloud"} title={t("usage.cloud")} onPress={() => choose({ runtime: "cloud" })} />
      </Sheet>
      <Sheet open={picking === "scope"} onClose={() => setPicking(null)} title={t("usage.scope")}>
        <Option kind="radio" checked={filter.scope === "all"} title={t("usage.everyone")} onPress={() => choose({ scope: "all" })} />
        <Option kind="radio" checked={filter.scope === "mine"} title={t("usage.mine")} onPress={() => choose({ scope: "mine" })} />
      </Sheet>
      <Sheet open={picking === "dates"} onClose={() => setPicking(null)} title={t("usage.rangeCustom")}>
        <DateRange from={filter.from ?? today} to={filter.to ?? today} onChange={(from, to) => change({ from, to })} />
      </Sheet>
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
            <RefreshControl refreshing={usage.isRefetching && !usage.isPlaceholderData} onRefresh={() => void usage.refetch()} tintColor={colors.subtle} />
          }
        >
          <Dashboard data={data} />
        </ScrollView>
      )}
    </View>
  );
}

/** A `byCli` name in words. */
function useHarnessLabel() {
  const { t } = useI18n();
  return (harness: string) =>
    harness === COORDINATOR_HARNESS ? t("usage.coordinator") : harness === UNKNOWN_HARNESS ? t("usage.unknownCli") : harnessName(harness);
}

function Dashboard({ data }: { data: UsageSummary }) {
  const { t, locale } = useI18n();
  const colors = useColors();
  const styles = useStyles();
  const name = useHarnessLabel();
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const { totals } = data;
  const tokens = (n: number) => formatTokens(n, locale);
  const time = (ms: number) => formatDuration(ms, t, locale);
  const turns = totals.turns ?? 0;
  const speed = usageSpeed(totals);
  // Work on a person's own CLI has no cost, rather than none.
  const cost = (micros: number) => (micros ? formatCost(micros, locale) : "–");
  const series = usageSeries(data, metric);
  const names = series.map((s) =>
    s.key === "cost" ? t("usage.costShort") : s.slot === null ? (s.harnesses.length === 1 ? name(s.harnesses[0]!) : t("usage.otherClis")) : name(s.key),
  );
  const format = (v: number) => (metric === "cost" ? formatCost(v, locale) : metric === "time" ? time(v) : metric === "turns" ? formatNumber(v, locale) : tokens(v));
  const cached = totals.cachedInputTokens > 0 ? ` · ${t("usage.cachedShare", { percent: Math.min(100, Math.round((totals.cachedInputTokens / Math.max(1, totals.inputTokens)) * 100)) })}` : "";

  return (
    <>
      <View style={styles.grid}>
        <Stat label={t("usage.tokens")} value={tokens(totals.inputTokens + totals.outputTokens)} hint={t("usage.inOut", { input: tokens(totals.inputTokens), output: tokens(totals.outputTokens) }) + cached} />
        {totals.turns !== undefined && (
          <>
            <Stat label={t("usage.turns")} value={formatNumber(turns, locale)} hint={totals.failedTurns ? t("usage.failedTurns", { count: totals.failedTurns }) : t("usage.noFailedTurns")} />
            <Stat label={t("usage.time")} value={time(totals.durationMs ?? 0)} hint={turns ? t("usage.perTurn", { time: time((totals.durationMs ?? 0) / turns) }) : undefined} />
            <Stat
              label={t(speed.model === null ? "usage.turnSpeed" : "usage.modelSpeed")}
              value={formatSpeed(speed.model ?? speed.turn, t, locale)}
              hint={speed.model === null ? t("usage.modelSpeedNone") : `${t("usage.turnSpeed")} ${formatSpeed(speed.turn, t, locale)}`}
            />
          </>
        )}
        <Stat label={t("usage.cost")} value={cost(totals.costMicros)} hint={totals.unpricedCalls > 0 ? t("usage.unpriced", { count: totals.unpricedCalls }) : t("usage.costCloudOnly")} />
      </View>

      {data.dailyByCli && (
        <Section title={t("usage.dailyByCli")}>
          <View style={styles.chart}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              {USAGE_METRICS.map((m) => (
                <Pressable
                  key={m}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: m === metric }}
                  onPress={() => setMetric(m)}
                  hitSlop={4}
                  style={[styles.pill, m === metric && { backgroundColor: colors.hover }]}
                >
                  <Text style={[styles.pillText, m === metric && { color: colors.fg }]}>{t(METRIC_LABEL[m])}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.legend}>
              {metric !== "cost" &&
                series.map((s, i) => (
                  <View key={s.key} style={styles.legendItem}>
                    <View style={[styles.swatch, { backgroundColor: seriesColor(colors, s.slot) }]} />
                    <Text style={styles.hint}>{names[i]}</Text>
                  </View>
                ))}
            </View>
            <UsageChart days={data.daily.map((d) => d.date)} series={series} names={names} format={format} />
          </View>
        </Section>
      )}

      {data.byCli && data.byCli.length > 0 && (
        <Section title={t("usage.byCli")}>
          {data.byCli.map((c) => {
            const own = usageSpeed(c);
            const where = c.harness === UNKNOWN_HARNESS ? null : t(c.runtime === "local" ? "usage.local" : "usage.cloud");
            return (
              <View key={`${c.harness}/${c.runtime}`} style={styles.line}>
                <View style={[styles.swatch, { backgroundColor: seriesColor(colors, chartSlot(c.harness)) }]} />
                <CliMark cli={c.harness} size={15} color={colors.body} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.lineName} numberOfLines={1}>
                    {name(c.harness)}
                  </Text>
                  <Text style={styles.hint}>{[where, `${t("usage.turns")} ${formatNumber(c.turns ?? 0, locale)}`, time(c.durationMs ?? 0)].filter(Boolean).join(" · ")}</Text>
                  <Text style={styles.hint}>
                    {t("usage.turnSpeed")} {formatSpeed(own.turn, t, locale)}
                  </Text>
                  {own.model !== null && (
                    <Text style={styles.hint}>
                      {t("usage.modelSpeed")} {formatSpeed(own.model, t, locale)}
                    </Text>
                  )}
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={styles.lineValue}>{tokens(c.inputTokens + c.outputTokens)}</Text>
                  {c.costMicros > 0 && <Text style={styles.hint}>{formatCost(c.costMicros, locale)}</Text>}
                </View>
              </View>
            );
          })}
        </Section>
      )}
      {data.byCli && <Text style={styles.hint}>{t("usage.speedHint")}</Text>}

      {data.byModel.length > 0 && (
        <Section title={t("usage.byModel")}>
          {data.byModel.map((m) => (
            <Line
              key={`${m.provider}/${m.model}`}
              name={modelName(m.model) || harnessName(m.provider)}
              value={cost(m.costMicros)}
              hint={t("stats.tokens", { tokens: tokens(m.inputTokens + m.outputTokens) })}
            />
          ))}
        </Section>
      )}

      <Section title={t("usage.topThreads")}>
        {data.topThreads.length === 0 ? (
          <Text style={styles.hint}>{t("usage.noThreadWork")}</Text>
        ) : (
          data.topThreads.map((th) => (
            <Line key={th.threadId} name={th.title} value={cost(th.costMicros)} hint={t("stats.tokens", { tokens: tokens(th.inputTokens + th.outputTokens) })} />
          ))
        )}
      </Section>
    </>
  );
}

function Filter({ label, title, onPress }: { label: string; title: string; onPress: () => void }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}: ${label}`} hitSlop={4} onPress={onPress} style={({ pressed }) => [styles.filter, pressed && { backgroundColor: colors.hover }]}>
      <Text style={styles.filterText}>{label}</Text>
      <ChevronDown size={13} color={colors.subtle} />
    </Pressable>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      {hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.section}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Line({ name, value, hint }: { name: string; value: string; hint: string }) {
  const styles = useStyles();
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

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    filters: { gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
    filter: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.edge, paddingHorizontal: 10, paddingVertical: 8 },
    filterText: { color: colors.body, fontSize: 13 },
    chart: { gap: 10, paddingVertical: 12 },
    pill: { borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 6 },
    pillText: { color: colors.muted, fontSize: 13 },
    legend: { flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 4 },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
    swatch: { width: 9, height: 9, borderRadius: 3 },
    page: { padding: 16, paddingTop: 6, gap: 20 },
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
  }),
);
