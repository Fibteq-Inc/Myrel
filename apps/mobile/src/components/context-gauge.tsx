import type { Locale, MessageKey } from "@myrel/i18n";
import { useI18n } from "@myrel/i18n/react";
import { PROMPT_PARTS, type PromptPart, type PromptSize, promptGauge } from "@myrel/protocol";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { formatTokens } from "../lib/format";
import { type Colors, makeStyles, radius, useColors } from "../theme";

const PART_COLORS: Record<PromptPart, keyof Colors> = {
  instructions: "frame",
  knowledge: "ok",
  brief: "merged",
  conversation: "accent",
  notes: "link",
  skills: "muted",
  other: "card",
};

const LEVEL_COLORS = { ok: "subtle", near: "warn", dropped: "bad" } as const;

function percent(share: number, locale: string) {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(share);
}

/** The small ring on the thread settings chip: how full the last turn's prompt was. */
export function ContextRing({ prompt }: { prompt: PromptSize }) {
  const { t, locale } = useI18n();
  const colors = useColors();
  const { share, level } = promptGauge(prompt);
  const r = 5;
  const length = 2 * Math.PI * r;
  return (
    <View accessible accessibilityLabel={t("context.ring", { percent: percent(share, locale) })}>
      <Svg width={14} height={14} viewBox="0 0 14 14" style={{ transform: [{ rotate: "-90deg" }] }}>
        <Circle cx={7} cy={7} r={r} fill="none" strokeWidth={2.5} stroke={colors.edge} />
        <Circle
          cx={7}
          cy={7}
          r={r}
          fill="none"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={`${Math.max(0.5, share * length)} ${length}`}
          stroke={colors[LEVEL_COLORS[level]]}
        />
      </Svg>
    </View>
  );
}

/**
 * The thread settings sheet's context part: what Myrel put in the agent's prompt on its last turn,
 * by kind, and what a long thread left out.
 */
export function ContextSection({ prompt }: { prompt: PromptSize }) {
  const { t, locale } = useI18n();
  const colors = useColors();
  const styles = useStyles();
  const { share, level } = promptGauge(prompt);
  const parts = PROMPT_PARTS.filter((p) => prompt.parts[p] > 0);
  const total = Math.max(prompt.limit, prompt.chars);
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.head}>
        <Text style={styles.section}>{t("context.title")}</Text>
        <Text style={[styles.share, { color: colors[LEVEL_COLORS[level]] }]}>{percent(share, locale)}</Text>
      </View>
      <View style={styles.bar}>
        {parts.map((p) => (
          <View key={p} style={{ width: `${(prompt.parts[p] / total) * 100}%`, backgroundColor: colors[PART_COLORS[p]] }} />
        ))}
      </View>
      <View style={{ gap: 3 }}>
        {parts.map((p) => (
          <View key={p} style={styles.row}>
            <View style={[styles.swatch, { backgroundColor: colors[PART_COLORS[p]] }]} />
            <Text style={styles.label} numberOfLines={1}>
              {t(`context.part.${p}` as MessageKey)}
            </Text>
            <Text style={styles.value}>{formatTokens(prompt.parts[p], locale)}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.hint}>{t("context.size", { chars: formatTokens(prompt.chars, locale), limit: formatTokens(prompt.limit, locale) })}</Text>
      {level !== "ok" && (
        <View style={[styles.alert, level === "near" ? { borderColor: colors.warnLine, backgroundColor: colors.warnSoft } : { borderColor: colors.bad, backgroundColor: colors.badSoft }]}>
          {level === "near" ? (
            <Text style={styles.alertText}>{t("context.near")}</Text>
          ) : (
            <>
              {prompt.droppedMessages > 0 && <Text style={styles.alertText}>{t("context.dropped", { count: prompt.droppedMessages })}</Text>}
              {prompt.droppedNotes > 0 && <Text style={styles.alertText}>{t("context.droppedNotes", { count: prompt.droppedNotes })}</Text>}
              {prompt.cut && <Text style={styles.alertText}>{t("context.cut")}</Text>}
            </>
          )}
          <Text style={styles.hint}>{t("context.advice")}</Text>
        </View>
      )}
      <Text style={styles.hint}>{t("context.hint")}</Text>
    </View>
  );
}

/** The prompt line in a reply's stats breakdown: its size against the limit, and what was left out. */
export function promptStatsValue(prompt: PromptSize, t: ReturnType<typeof useI18n>["t"], locale: Locale): string {
  const size = t("stats.promptValue", { chars: formatTokens(prompt.chars, locale), limit: formatTokens(prompt.limit, locale) });
  return prompt.droppedMessages > 0 ? `${size} · ${t("stats.promptDropped", { count: prompt.droppedMessages })}` : size;
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    head: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
    section: { color: colors.subtle, fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 },
    share: { fontSize: 13, fontVariant: ["tabular-nums"] },
    bar: { flexDirection: "row", height: 8, borderRadius: 4, overflow: "hidden", backgroundColor: colors.line },
    row: { flexDirection: "row", alignItems: "center", gap: 8 },
    swatch: { width: 8, height: 8, borderRadius: 2 },
    label: { flex: 1, color: colors.muted, fontSize: 13 },
    value: { color: colors.body, fontSize: 13, fontVariant: ["tabular-nums"] },
    hint: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    alert: { gap: 4, borderRadius: radius.sm, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8 },
    alertText: { color: colors.body, fontSize: 13, lineHeight: 18 },
  }),
);
