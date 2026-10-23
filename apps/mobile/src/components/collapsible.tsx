import { useT } from "@myrel/i18n/react";
import { type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { makeStyles } from "../theme";

/**
 * Folds long content to `height` points behind a "Show more" button, so one
 * long message does not take over the conversation. Content only a little
 * over the limit (under `slack` times it) stays open: folding away a line or
 * two helps nobody. `long` starts it folded when the caller already knows the
 * content is long, so it does not first show in full and then jump.
 */
export function Collapsible({
  height,
  slack = 1.3,
  long: knownLong = false,
  children,
}: {
  height: number;
  slack?: number;
  long?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const styles = useStyles();
  const [measuredLong, setMeasuredLong] = useState(false);
  const [open, setOpen] = useState(false);
  const long = knownLong || measuredLong;
  const folded = long && !open;
  return (
    <View>
      <View style={folded ? { maxHeight: height, overflow: "hidden" } : undefined}>
        {/* Only measure unfolded: text laid out inside the clip is cut to its height, so measuring it
            then would unfold the content, measure it long again and fold it, over and over (a flicker). */}
        <View onLayout={(e) => !folded && setMeasuredLong(e.nativeEvent.layout.height > height * slack)}>
          {children}
        </View>
      </View>
      {long && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          hitSlop={8}
          style={styles.toggle}
        >
          <Text style={styles.toggleText}>{open ? t("message.showLess") : t("message.showMore")}</Text>
        </Pressable>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    toggle: { alignSelf: "flex-start", marginTop: 6 },
    toggleText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  }),
);
