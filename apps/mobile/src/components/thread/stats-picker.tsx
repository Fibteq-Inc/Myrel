import { useI18n } from "@myrel/i18n/react";
import { type Message, threadWork, timeSplit, usageSpeed, type WorkStats } from "@myrel/protocol";
import { ChartColumn } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { formatCost, formatDuration, formatPercent, formatSpeed, formatTokens, modelName } from "../../lib/format";
import { type Colors, makeStyles, radius, useColors } from "../../theme";
import { CliMark } from "../ui";
import { Sheet } from "../cli-picker";
import { harnessName } from "../message-stats";
import { useThreadStatsMessages } from "./usage";

type Props = {
  projectId: string;
  threadId: string;
  /** The messages held, the newest ones at least. */
  messages: Message[];
  /** Every message of the thread is held. */
  complete: boolean;
  /** Changes when the thread's usage does. */
  version: string;
  onDetails: () => void;
};

/** Thread: a chip opening its statistics in short, as on the web. The Usage tab has the rest. */
export function ThreadStatsPicker(props: Props) {
  const { t } = useI18n();
  const colors = useColors();
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("threadStats.button")}
        hitSlop={6}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.chip, pressed && { backgroundColor: colors.hover }]}
      >
        <ChartColumn size={15} color={colors.muted} />
      </Pressable>
      <Sheet open={open} onClose={close} title={t("threadStats.title")}>
        {/* Added up only while it is open. */}
        {open && (
          <ThreadStats
            {...props}
            onDetails={() => {
              close();
              props.onDetails();
            }}
          />
        )}
      </Sheet>
    </>
  );
}

const SPLIT = [
  { key: "modelMs", label: "threadStats.splitModel", color: "chart1" },
  { key: "restMs", label: "threadStats.splitRest", color: "chart2" },
  { key: "waitMs", label: "threadStats.splitWait", color: "chart4" },
] as const satisfies readonly { key: string; label: string; color: keyof Colors }[];

/** The last turn, the thread so far, where the time went and who did the work. */
function ThreadStats(props: Props) {
  const { t, locale } = useI18n();
  const colors = useColors();
  const styles = useStyles();
  const all = useThreadStatsMessages(props);
  const { total, last, groups } = useMemo(() => threadWork(all ?? props.messages), [all, props.messages]);
  if (!last) return <Text style={styles.hint}>{t("threadStats.empty")}</Text>;
  const split = timeSplit(total);
  const parts = split ? SPLIT.map((p) => ({ ...p, ms: split[p.key] })).filter((p) => p.ms > 0) : [];
  const local = groups.some((g) => g.runtime === "local" && g.harness);
  return (
    <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ gap: 14 }}>
      <View style={styles.block}>
        <Text style={styles.section}>{t("threadStats.lastTurn")}</Text>
        <Figures work={last} />
      </View>
      {total.turns > 1 && (
        <View style={styles.block}>
          <Text style={styles.section}>
            {t("threadStats.thread")}, {t("threadStats.turns", { count: total.turns })}
          </Text>
          <Figures work={total} />
        </View>
      )}
      {parts.length > 0 && (
        <View style={styles.block}>
          <Text style={styles.section}>{t("threadStats.split")}</Text>
          <View style={styles.bar}>
            {parts.map((p) => (
              <View key={p.key} style={{ flex: p.ms, backgroundColor: colors[p.color] }} />
            ))}
          </View>
          {parts.map((p) => (
            <View key={p.key} style={styles.row}>
              <View style={[styles.swatch, { backgroundColor: colors[p.color] }]} />
              <Text style={styles.label}>{t(p.label)}</Text>
              <Text style={styles.value}>{formatDuration(p.ms, t, locale)}</Text>
            </View>
          ))}
          {total.measuredMs < total.durationMs && <Text style={styles.hint}>{t("threadStats.splitPart")}</Text>}
        </View>
      )}
      <View style={styles.block}>
        <Text style={styles.section}>{t("threadStats.byCli")}</Text>
        {groups.map((g) => {
          const speed = usageSpeed(g);
          const model = modelName(g.model);
          return (
            <View key={g.key} style={styles.row}>
              {g.harness && <CliMark cli={g.harness} size={15} color={colors.body} />}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.name} numberOfLines={1}>
                  {g.harness ? harnessName(g.harness) : model}
                </Text>
                <Text style={styles.hint} numberOfLines={1}>
                  {[g.harness && model, g.computer ?? t(g.runtime === "local" ? "stats.local" : "stats.cloud")].filter(Boolean).join(" · ")}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.value}>{t("stats.tokens", { tokens: formatTokens(g.inputTokens + g.outputTokens, locale) })}</Text>
                {/* Each speed under its own name: they are not comparable. */}
                <Text style={styles.hint}>
                  {t(speed.model === null ? "usage.turnSpeed" : "usage.modelSpeed")} {formatSpeed(speed.model ?? speed.turn, t, locale)}
                </Text>
              </View>
            </View>
          );
        })}
      </View>
      {local && <Text style={styles.hint}>{t("threadStats.localCost")}</Text>}
      <Pressable accessibilityRole="button" onPress={props.onDetails} hitSlop={8}>
        <Text style={styles.link}>{t("threadStats.details")}</Text>
      </Pressable>
    </ScrollView>
  );
}

function Figures({ work }: { work: WorkStats }) {
  const { t, locale } = useI18n();
  const styles = useStyles();
  const speed = usageSpeed(work);
  const rows: [string, string][] = [
    [t("usage.modelSpeed"), formatSpeed(speed.model, t, locale)],
    [t("usage.turnSpeed"), formatSpeed(speed.turn, t, locale)],
    [t("usage.time"), formatDuration(work.durationMs, t, locale)],
    [t("threadStats.inOut"), `${formatTokens(work.inputTokens, locale)} / ${formatTokens(work.outputTokens, locale)}`],
  ];
  if (work.cachedInputTokens > 0 && work.inputTokens > 0) rows.push([t("stats.cached"), formatPercent(Math.min(1, work.cachedInputTokens / work.inputTokens), locale)]);
  if (work.costMicros) rows.push([t("stats.cost"), formatCost(work.costMicros, locale)]);
  return (
    <View style={styles.figures}>
      {rows.map(([label, value]) => (
        <View key={label} style={styles.figure}>
          <Text style={styles.hint}>{label}</Text>
          <Text style={styles.figureValue} numberOfLines={1}>
            {value}
          </Text>
        </View>
      ))}
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    chip: { alignItems: "center", justifyContent: "center", borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 7 },
    block: { gap: 6 },
    section: { color: colors.subtle, fontSize: 13, fontWeight: "600" },
    figures: { flexDirection: "row", flexWrap: "wrap", rowGap: 8 },
    figure: { width: "50%", paddingRight: 8 },
    figureValue: { color: colors.fg, fontSize: 16, fontWeight: "600" },
    bar: { flexDirection: "row", gap: 2, height: 8, borderRadius: 4, overflow: "hidden" },
    row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2 },
    swatch: { width: 9, height: 9, borderRadius: 3 },
    label: { flex: 1, color: colors.muted, fontSize: 14 },
    name: { color: colors.body, fontSize: 14 },
    value: { color: colors.body, fontSize: 14, fontVariant: ["tabular-nums"] },
    hint: { color: colors.subtle, fontSize: 12, lineHeight: 17 },
    link: { color: colors.link, fontSize: 14 },
  }),
);
