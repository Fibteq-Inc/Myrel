import { useT } from "@myrel/i18n/react";
import { type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

/**
 * Folds long content to `height` points behind a "Show more" button, so one
 * long message does not take over the conversation. Content only a little
 * over the limit (under `slack` times it) stays open: folding away a line or
 * two helps nobody.
 */
export function Collapsible({ height, slack = 1.3, children }: { height: number; slack?: number; children: ReactNode }) {
  const t = useT();
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  const folded = long && !open;
  return (
    <View>
      <View style={folded ? { maxHeight: height, overflow: "hidden" } : undefined}>
        {/* The inner view keeps its full height while the outer one clips it. */}
        <View onLayout={(e) => setLong(e.nativeEvent.layout.height > height * slack)}>{children}</View>
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

const styles = StyleSheet.create({
  toggle: { alignSelf: "flex-start", marginTop: 6 },
  toggleText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
});
