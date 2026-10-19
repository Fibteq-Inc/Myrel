import { parseChecklist } from "@altair/client";
import { CircleCheck, CircleDashed } from "lucide-react-native";
import { StyleSheet, Text, View } from "react-native";
import { colors, mono } from "../theme";
import { Spinner } from "./ui";

/** A thread agent's `update_status` checklist with a progress bar. */
export function Checklist({ text, live = true }: { text: string; live?: boolean }) {
  const { title, items } = parseChecklist(text);
  if (items.length === 0) return <Text style={styles.plain}>{text}</Text>;
  const done = items.filter((i) => i.state === "done").length;
  return (
    <View style={{ gap: 10 }}>
      <View style={styles.head}>
        <Text style={styles.title} numberOfLines={1}>
          {title || "Progress"}
        </Text>
        <Text style={styles.count}>
          {done} / {items.length}
        </Text>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: items.length, now: done }}
        style={styles.track}
      >
        <View style={[styles.bar, { width: `${(done / items.length) * 100}%` }]} />
      </View>
      <View style={{ gap: 8 }}>
        {items.map((item, i) => (
          <View key={i} style={styles.item}>
            <View style={{ marginTop: 2 }}>
              {item.state === "done" && <CircleCheck size={16} color={colors.ok} accessibilityLabel="Done" />}
              {item.state === "active" &&
                (live ? <Spinner size={16} /> : <CircleDashed size={16} color={colors.accent} />)}
              {item.state === "todo" && <CircleDashed size={16} color={colors.subtle} />}
            </View>
            <Text
              style={[
                styles.itemText,
                item.state === "done" && { color: colors.muted },
                item.state === "active" && { color: colors.fg, fontWeight: "600" },
                item.state === "todo" && { color: colors.subtle },
              ]}
            >
              {item.text}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  plain: { color: colors.muted, fontSize: 14 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, color: colors.subtle, fontSize: 13 },
  count: { color: colors.subtle, fontSize: 13, fontFamily: mono },
  track: { height: 4, borderRadius: 2, backgroundColor: "#222227", overflow: "hidden" },
  bar: { height: "100%", borderRadius: 2, backgroundColor: colors.accent },
  item: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  itemText: { flex: 1, fontSize: 15, lineHeight: 21 },
});
