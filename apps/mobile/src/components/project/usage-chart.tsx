import type { UsageSeries } from "@myrel/client";
import { useI18n } from "@myrel/i18n/react";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { formatDay } from "../../lib/format";
import { type Colors, makeStyles, useColors } from "../../theme";

const HEIGHT = 150;

/** A series' color; the ones without a color of their own share a neutral. */
export function seriesColor(colors: Colors, slot: number | null): string {
  return slot === null ? colors.subtle : colors[`chart${slot}` as keyof Colors];
}

/** Stacked daily bars, as on the web. Tap a day for its numbers, shown above. */
export function UsageChart({ days, series, names, format }: { days: string[]; series: UsageSeries[]; names: string[]; format: (v: number) => string }) {
  const { t, locale } = useI18n();
  const colors = useColors();
  const styles = useStyles();
  const [picked, setPicked] = useState<number | null>(null);
  const totals = days.map((_, i) => series.reduce((sum, s) => sum + s.values[i]!, 0));
  const max = Math.max(1, ...totals);
  // A shorter range may not have the picked day anymore.
  const day = picked !== null && picked < days.length ? picked : null;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ minHeight: 18 }}>
        {day === null ? (
          <Text style={styles.hint}>
            {t("usage.mostInDay")} {format(Math.max(0, ...totals))}
          </Text>
        ) : (
          <Text style={styles.hint}>
            <Text style={{ color: colors.fg }}>{formatDay(days[day]!, locale)}</Text>
            {` · ${t("usage.total")} ${format(totals[day]!)}`}
            {series.length > 1 && series.flatMap((s, i) => (s.values[day] ? ` · ${names[i]} ${format(s.values[day])}` : [])).join("")}
          </Text>
        )}
      </View>
      <View style={styles.plot}>
        {days.map((d, i) => (
          <Pressable
            key={d}
            accessibilityRole="button"
            accessibilityLabel={`${formatDay(d, locale)}: ${format(totals[i]!)}`}
            onPress={() => setPicked(i === day ? null : i)}
            style={styles.column}
          >
            <View style={[styles.stack, { opacity: day === null || day === i ? 1 : 0.45 }]}>
              {/* Last series on top, so the first sits on the baseline. */}
              {[...series].reverse().map((s) =>
                s.values[i] ? <View key={s.key} style={{ height: Math.max(1, (s.values[i] / max) * HEIGHT - 2), backgroundColor: seriesColor(colors, s.slot) }} /> : null,
              )}
            </View>
          </Pressable>
        ))}
      </View>
      <View style={styles.ends}>
        <Text style={styles.hint}>{formatDay(days[0]!, locale)}</Text>
        {days.length > 1 && <Text style={styles.hint}>{formatDay(days.at(-1)!, locale)}</Text>}
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    hint: { color: colors.subtle, fontSize: 12, lineHeight: 17 },
    plot: { flexDirection: "row", height: HEIGHT, borderBottomWidth: 1, borderBottomColor: colors.line },
    column: { flex: 1, justifyContent: "flex-end", alignItems: "center" },
    stack: { width: "62%", maxWidth: 24, gap: 2, borderTopLeftRadius: 3, borderTopRightRadius: 3, overflow: "hidden" },
    ends: { flexDirection: "row", justifyContent: "space-between" },
  }),
);
