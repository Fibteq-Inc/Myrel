import { ChevronRight } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { makeStyles, radius, useColors } from "../theme";

/** A titled card of settings, with an optional hint under it. Used by the app and project settings. */
export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.section}>{title}</Text>
      <View style={styles.card}>{children}</View>
      {hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

/** A setting's label and its current value; pressing it opens the choices. Without onPress it only shows the value. */
export function ValueRow({ label, value, onPress }: { label: string; value: string; onPress?: () => void }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={`${label}: ${value}`}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.value}>{value}</Text>
      </View>
      {onPress && <ChevronRight size={16} color={colors.subtle} />}
    </Pressable>
  );
}

/** A short warning or error line inside a section. */
export function Notice({ children, tone = "warn" }: { children: ReactNode; tone?: "warn" | "bad" }) {
  const colors = useColors();
  const styles = useStyles();
  return <Text style={[styles.notice, { color: tone === "bad" ? colors.bad : colors.warn }]}>{children}</Text>;
}

export const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    section: { color: colors.subtle, fontSize: 13, fontWeight: "600" },
    card: {
      gap: 4,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.raised,
      padding: 14,
    },
    row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
    label: { color: colors.subtle, fontSize: 13 },
    value: { color: colors.fg, fontSize: 15 },
    hint: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    notice: { fontSize: 13, lineHeight: 18, paddingVertical: 4 },
  }),
);
