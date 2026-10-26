import { useI18n } from "@myrel/i18n/react";
import { type Goal, GOAL_MAX_THREADS } from "@myrel/protocol";
import { Square, Target } from "lucide-react-native";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { makeStyles, radius, useColors } from "../../theme";

/**
 * Above the project chat while a standing goal is open: what the coordinator keeps working toward
 * by itself, until when, and a way for any member to stop it.
 */
export function GoalBanner({ goal, onStop }: { goal: Goal; onStop: () => void }) {
  const { t, locale } = useI18n();
  const colors = useColors();
  const styles = useStyles();
  const time = new Date(goal.until).toLocaleString(locale, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const stop = () =>
    Alert.alert(t("goal.stopTitle"), t("goal.stopConfirm"), [
      { text: t("mobile.cancel"), style: "cancel" },
      { text: t("goal.stop"), style: "destructive", onPress: onStop },
    ]);
  return (
    <View style={styles.banner}>
      <Target size={16} color={colors.accent} style={{ marginTop: 2 }} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.title}>{t("goal.until", { time })}</Text>
        <Text style={styles.text} numberOfLines={2}>
          {goal.text}
        </Text>
        <Text style={styles.meta}>{t("goal.threads", { count: String(goal.threads), max: String(GOAL_MAX_THREADS) })}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={stop}
        hitSlop={8}
        style={({ pressed }) => [styles.button, pressed && { backgroundColor: colors.hover }]}
      >
        <Square size={10} color={colors.muted} />
        <Text style={styles.meta}>{t("goal.stop")}</Text>
      </Pressable>
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    banner: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
      marginHorizontal: 12,
      marginTop: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      backgroundColor: colors.raised,
    },
    title: { color: colors.fg, fontSize: 13, fontWeight: "600" },
    text: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    meta: { color: colors.muted, fontSize: 12 },
    button: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 4 },
  }),
);
