import { localDay } from "@myrel/client";
import { dateFormat, type Locale } from "@myrel/i18n";
import { useI18n } from "@myrel/i18n/react";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { formatDay } from "../../lib/format";
import { makeStyles, radius, useColors } from "../../theme";

const DAY_MS = 86_400_000;
const at = (day: string) => Date.parse(`${day}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Monday to Sunday in one letter. */
function weekdayNames(locale: Locale): string[] {
  const format = dateFormat(locale, { weekday: "narrow", timeZone: "UTC" });
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(Date.UTC(2024, 0, 1 + i))));
}

/**
 * A month to tap two days in: the first tap starts the range, the second ends it (either way round).
 * Plain views, so it needs no native date picker and ships with an update over the air.
 */
export function DateRange({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const { t, locale } = useI18n();
  const colors = useColors();
  const styles = useStyles();
  const today = localDay(new Date());
  const [month, setMonth] = useState(`${to.slice(0, 8)}01`);
  /** The first tap, waiting for the second. */
  const [start, setStart] = useState<string | null>(null);
  const first = at(month);
  const [year, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1];
  const count = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
  // Monday first.
  const lead = (new Date(first).getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: count }, (_, i) => iso(first + i * DAY_MS))];
  while (cells.length % 7) cells.push(null);
  const move = (by: number) => setMonth(iso(Date.UTC(year, m + by, 1)));
  const pick = (day: string) => {
    if (start === null) {
      setStart(day);
      return onChange(day, day);
    }
    setStart(null);
    const [a, b] = [start, day].sort();
    onChange(a!, b!);
  };
  const weekdays = weekdayNames(locale);
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.head}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("usage.previousMonth")} hitSlop={8} onPress={() => move(-1)} style={styles.arrow}>
          <ChevronLeft size={18} color={colors.muted} />
        </Pressable>
        <Text style={styles.month}>{formatDay(month, locale, true)}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t("usage.nextMonth")} hitSlop={8} disabled={month.slice(0, 7) >= today.slice(0, 7)} onPress={() => move(1)} style={styles.arrow}>
          <ChevronRight size={18} color={month.slice(0, 7) >= today.slice(0, 7) ? colors.frame : colors.muted} />
        </Pressable>
      </View>
      <View style={styles.week}>
        {weekdays.map((d, i) => (
          <Text key={i} style={styles.weekday}>
            {d}
          </Text>
        ))}
      </View>
      <View style={styles.grid}>
        {cells.map((day, i) => {
          if (!day) return <View key={i} style={styles.cell} />;
          const later = day > today;
          const end = day === from || day === to;
          const inside = day > from && day < to;
          return (
            <Pressable
              key={i}
              accessibilityRole="button"
              accessibilityLabel={formatDay(day, locale)}
              accessibilityState={{ selected: end || inside, disabled: later }}
              disabled={later}
              onPress={() => pick(day)}
              style={[styles.cell, inside && { backgroundColor: colors.accentSoft }, end && styles.end]}
            >
              <Text style={[styles.day, later && { color: colors.frame }, end && { color: colors.onAccent }]}>{Number(day.slice(8))}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.range}>
        {t("usage.from")} {formatDay(from, locale)} · {t("usage.to")} {formatDay(to, locale)}
      </Text>
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    arrow: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
    month: { color: colors.fg, fontSize: 15, fontWeight: "600" },
    week: { flexDirection: "row" },
    weekday: { width: `${100 / 7}%`, textAlign: "center", color: colors.subtle, fontSize: 12 },
    grid: { flexDirection: "row", flexWrap: "wrap" },
    cell: { width: `${100 / 7}%`, height: 40, alignItems: "center", justifyContent: "center" },
    end: { backgroundColor: colors.accent, borderRadius: radius.sm },
    day: { color: colors.body, fontSize: 15, fontVariant: ["tabular-nums"] },
    range: { color: colors.subtle, fontSize: 13 },
  }),
);
