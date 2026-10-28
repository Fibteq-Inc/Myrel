import { useI18n } from "@myrel/i18n/react";
import { CLI_NAMES, type MessageStats } from "@myrel/protocol";
import { Cloud, Laptop } from "lucide-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { formatCost, formatDuration, formatTokens, modelName } from "../lib/format";
import { makeStyles, mono, radius, useColors } from "../theme";
import { promptStatsValue } from "./context-gauge";

const HARNESS_NAMES: Record<string, string> = { ...CLI_NAMES, opencode: "OpenCode", "claude-code": "Claude Code", shell: "Shell" };
export const harnessName = (h: string) => HARNESS_NAMES[h] ?? h;

/**
 * The quiet line under an agent's reply: where it ran, the model, how long it
 * took, tokens and cost. Tapping it opens the breakdown.
 */
export function MessageStatsLine({ stats }: { stats: MessageStats }) {
  const { t, locale } = useI18n();
  const colors = useColors();
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const { task } = stats;
  const durationMs = stats.durationMs + (task?.durationMs ?? 0);
  const tokens = stats.inputTokens + stats.outputTokens + (task ? task.inputTokens + task.outputTokens : 0);
  const cost =
    stats.costMicros === null || (task && task.costMicros === null)
      ? null
      : stats.costMicros + (task?.costMicros ?? 0);
  const local = stats.runtime === "local";
  const RuntimeIcon = local ? Laptop : Cloud;
  const harness = task?.harness ?? stats.harness;
  const parts = [
    modelName(task?.model ?? stats.model),
    harness ? harnessName(harness) : null,
    formatDuration(durationMs, t, locale),
    tokens > 0 ? t("stats.tokens", { tokens: formatTokens(tokens, locale) }) : null,
    cost ? formatCost(cost, locale) : null,
  ].filter(Boolean);

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("stats.label")}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        hitSlop={6}
        style={styles.line}
      >
        <RuntimeIcon size={12} color={colors.subtle} />
        <Text style={styles.text} numberOfLines={1}>
          {stats.computer ?? t(local ? "stats.local" : "stats.cloud")} · {parts.join(" · ")}
        </Text>
      </Pressable>
      {open && (
        <View style={styles.box}>
          {task && <Row label={t("stats.task")} value={task.title} />}
          {!!stats.computer && <Row label={t("stats.computer")} value={stats.computer} />}
          {stats.harness && <Row label={t("stats.harness")} value={harnessName(stats.harness)} />}
          {!!stats.model && <Row label={t("stats.model")} value={modelName(stats.model)} mono />}
          <Row label={t("stats.time")} value={formatDuration(stats.durationMs, t, locale)} />
          {!stats.harness && <Row label={t("stats.calls")} value={String(stats.calls)} />}
          <Row label={t("stats.input")} value={formatTokens(stats.inputTokens, locale)} />
          {stats.cachedInputTokens > 0 && <Row label={t("stats.cached")} value={formatTokens(stats.cachedInputTokens, locale)} />}
          <Row label={t("stats.output")} value={formatTokens(stats.outputTokens, locale)} />
          <Row label={t("stats.cost")} value={cost === null ? t("stats.unpriced") : formatCost(cost, locale)} />
          {stats.prompt && <Row label={t("stats.prompt")} value={promptStatsValue(stats.prompt, t, locale)} />}
        </View>
      )}
    </View>
  );
}

function Row({ label, value, mono: isMono = false }: { label: string; value: string; mono?: boolean }) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, isMono && { fontFamily: mono, fontSize: 11 }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    line: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", maxWidth: "100%" },
    text: { color: colors.subtle, fontSize: 12, flexShrink: 1 },
    box: {
      marginTop: 6,
      gap: 4,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.panel,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    row: { flexDirection: "row", gap: 12 },
    label: { color: colors.subtle, fontSize: 12, width: 96 },
    value: { color: colors.body, fontSize: 12, flex: 1 },
  }),
);
