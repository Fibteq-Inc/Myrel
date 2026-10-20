import { checklistProgress, parseChecklist } from "@altair/client";
import { useT } from "@altair/i18n/react";
import { CircleCheck, CircleDashed, CircleMinus, CircleX } from "lucide-react-native";
import { StyleSheet, Text, View } from "react-native";
import { colors, mono } from "../theme";
import { Spinner } from "./ui";

/**
 * A thread agent's plan as a checklist with a progress bar. A task's own steps
 * are indented under the plan step they run in; skipped steps stay visible,
 * struck through.
 */
export function Checklist({ text, live = true }: { text: string; live?: boolean }) {
  const t = useT();
  const { title, items } = parseChecklist(text);
  if (items.length === 0) return <Text style={styles.plain}>{text}</Text>;
  const { done, total } = checklistProgress(items);
  return (
    <View style={{ gap: 10 }}>
      <View style={styles.head}>
        <Text style={styles.title} numberOfLines={1}>
          {title || t("checklist.progress")}
        </Text>
        <Text style={styles.count}>
          {done} / {total}
        </Text>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={t("checklist.progress")}
        accessibilityValue={{ min: 0, max: total, now: done }}
        style={styles.track}
      >
        <View style={[styles.bar, { width: `${total ? (done / total) * 100 : 0}%` }]} />
      </View>
      <View style={{ gap: 8 }}>
        {items.map((item, i) => {
          const nested = item.depth > 0;
          const size = nested ? 14 : 16;
          return (
            <View key={i} style={[styles.item, { marginLeft: item.depth * 22 }]}>
              <View style={{ marginTop: 2 }}>
                {item.state === "done" && <CircleCheck size={size} color={colors.ok} accessibilityLabel={t("checklist.done")} />}
                {item.state === "active" &&
                  (live ? <Spinner size={size} /> : <CircleDashed size={size} color={colors.accent} accessibilityLabel={t("checklist.stopped")} />)}
                {item.state === "todo" && <CircleDashed size={size} color={colors.subtle} accessibilityLabel={t("checklist.todo")} />}
                {item.state === "failed" && <CircleX size={size} color={colors.bad} accessibilityLabel={t("checklist.failed")} />}
                {item.state === "skipped" && <CircleMinus size={size} color={colors.subtle} accessibilityLabel={t("checklist.skipped")} />}
              </View>
              <Text
                style={[
                  styles.itemText,
                  nested && { fontSize: 13, lineHeight: 19 },
                  item.state === "done" && { color: colors.muted },
                  item.state === "active" && { color: colors.fg, fontWeight: "600" },
                  (item.state === "todo" || item.state === "failed") && { color: colors.subtle },
                  item.state === "skipped" && { color: colors.subtle, textDecorationLine: "line-through" },
                ]}
              >
                {item.text}
              </Text>
            </View>
          );
        })}
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
  step: { flex: 1, color: colors.muted, fontSize: 13 },
  cardRow: { flexDirection: "row", gap: 12 },
  card: {
    flex: 1,
    minWidth: 0,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
});

/** An agent's plan as a card in the conversation, where the work started. It stays once the work is done. */
export function PlanCard({ text, live }: { text: string; live: boolean }) {
  return (
    <View style={styles.cardRow}>
      {/* Lines up with the agent's messages, under its mark. */}
      <View style={{ width: 28 }} />
      <View style={styles.card}>
        <Checklist text={text} live={live} />
      </View>
    </View>
  );
}

/** The thread's progress in one line above the conversation: the step the agent is on and how many are done. */
export function PlanProgress({ text, live }: { text: string; live: boolean }) {
  const t = useT();
  const { title, items } = parseChecklist(text);
  if (items.length === 0) return null;
  const { done, total } = checklistProgress(items);
  const step = items.findLast((i) => i.state === "active") ?? items.find((i) => i.state === "failed");
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.head}>
        {step?.state === "failed" ? (
          <CircleX size={14} color={colors.bad} />
        ) : live && step ? (
          <Spinner size={14} />
        ) : done === total ? (
          <CircleCheck size={14} color={colors.ok} />
        ) : (
          <CircleDashed size={14} color={colors.subtle} />
        )}
        <Text style={styles.step} numberOfLines={1}>
          {step?.text ?? (title || t("checklist.progress"))}
        </Text>
        <Text style={styles.count}>
          {done} / {total}
        </Text>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={t("checklist.progress")}
        accessibilityValue={{ min: 0, max: total, now: done }}
        style={styles.track}
      >
        <View style={[styles.bar, { width: `${total ? (done / total) * 100 : 0}%` }]} />
      </View>
    </View>
  );
}
