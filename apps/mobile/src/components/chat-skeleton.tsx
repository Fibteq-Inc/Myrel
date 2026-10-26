import { useT } from "@myrel/i18n/react";
import { useEffect, useRef } from "react";
import { Animated, type DimensionValue, Easing, StyleSheet, View } from "react-native";
import { makeStyles } from "../theme";

/** Rows of the placeholder, oldest first: an agent's reply (its line widths) or a person's bubble. */
const ROWS: ({ agent: DimensionValue[] } | { bubble: DimensionValue })[] = [
  { agent: ["92%", "80%", "40%"] },
  { bubble: "45%" },
  { agent: ["100%", "75%"] },
  { bubble: "35%" },
  { agent: ["85%", "50%"] },
];

/** The shape of a conversation while its messages load, in place of a spinner. Pulses like `animate-pulse` on web. */
export function ChatSkeleton() {
  const t = useT();
  const styles = useStyles();
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const ease = Easing.inOut(Easing.ease);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.5, duration: 1000, easing: ease, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 1000, easing: ease, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View accessible accessibilityRole="progressbar" accessibilityLabel={t("chat.loading")} style={[styles.rows, { opacity: pulse }]}>
      {ROWS.map((row, i) =>
        "bubble" in row ? (
          <View key={i} style={[styles.bubble, { width: row.bubble }]} />
        ) : (
          <View key={i} style={styles.agent}>
            <View style={styles.mark} />
            <View style={styles.lines}>
              {row.agent.map((width, j) => (
                <View key={j} style={[styles.line, { width }]} />
              ))}
            </View>
          </View>
        ),
      )}
    </Animated.View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    rows: { gap: 22 },
    agent: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
    mark: { width: 28, height: 28, borderRadius: 8, backgroundColor: colors.bubble },
    lines: { flex: 1, gap: 10, paddingTop: 6 },
    line: { height: 12, borderRadius: 4, backgroundColor: colors.bubble },
    bubble: { alignSelf: "flex-end", height: 42, borderRadius: 18, borderBottomRightRadius: 6, backgroundColor: colors.bubble },
  }),
);
