import { type ChecklistItem, checklistProgress, freshSteps, parseChecklist } from "@myrel/client";
import type { PlanUpdate } from "@myrel/protocol";
import { useT } from "@myrel/i18n/react";
import { ChevronDown, CircleCheck, CircleDashed, CircleMinus, CircleX, ListChecks } from "lucide-react-native";
import { useEffect, useReducer, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { makeStyles, mono, useColors } from "../theme";
import { Spinner } from "./ui";

/**
 * A thread agent's plan as a checklist with a progress bar. A task's own steps
 * are indented under the plan step they run in; skipped steps stay visible,
 * struck through.
 */
export function Checklist({ text, live = true, fresh }: { text: string; live?: boolean; fresh?: ReadonlySet<string> }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
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
                {item.depth === 0 && fresh?.has(item.text) && <Text style={styles.newTag}>{"  " + t("checklist.new")}</Text>}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    plain: { color: colors.muted, fontSize: 14 },
    head: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { flex: 1, color: colors.subtle, fontSize: 13 },
    count: { color: colors.subtle, fontSize: 13, fontFamily: mono },
    track: { height: 4, borderRadius: 2, backgroundColor: colors.divider, overflow: "hidden" },
    bar: { height: "100%", borderRadius: 2, backgroundColor: colors.accent },
    item: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
    itemText: { flex: 1, fontSize: 15, lineHeight: 21 },
    step: { flex: 1, color: colors.muted, fontSize: 13 },
    newTag: { color: colors.accent, fontSize: 12, fontWeight: "600" },
    badge: {
      color: colors.onAccent,
      backgroundColor: colors.accent,
      fontSize: 11,
      fontWeight: "700",
      borderRadius: 8,
      overflow: "hidden",
      paddingHorizontal: 6,
      lineHeight: 16,
    },
    link: { color: colors.accent, fontSize: 13 },
    note: { flex: 1, minWidth: 0, borderRadius: 12, borderWidth: 1, borderStyle: "dashed", borderColor: colors.edge },
    noteHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 9 },
    noteText: { flex: 1, color: colors.muted, fontSize: 13 },
    noteBody: { gap: 6, paddingHorizontal: 12, paddingBottom: 10 },
    noteMark: { width: 14, textAlign: "center", color: colors.subtle, fontSize: 14 },
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
  }),
);

/** An agent's plan as a card in the conversation, where the work started. It stays once the work is done. */
export function PlanCard({ text, live }: { text: string; live: boolean }) {
  const styles = useStyles();
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

/** The plan steps the person has had in view, per plan (thread and title), for this session. */
const seenSteps = new Map<string, Set<string>>();

/**
 * The plan steps added since the person last opened the plan. A plan seen for
 * the first time counts as seen, so only steps the agent adds later are new.
 */
function useFreshSteps(key: string, items: ChecklistItem[]) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const shown = () => new Set(items.filter((i) => i.depth === 0).map((i) => i.text));
  if (!seenSteps.has(key)) seenSteps.set(key, shown());
  const fresh = freshSteps(items, seenSteps.get(key)!);
  const markSeen = () => {
    seenSteps.set(key, shown());
    rerender();
  };
  return { fresh, markSeen };
}

/**
 * The thread's progress in one line above the conversation: the step the agent
 * is on and how many are done, with a badge when the agent added steps. Tapping
 * opens the whole plan right there, so nobody has to scroll back to the card.
 */
export function PlanProgress({
  planKey,
  text,
  live,
  open,
  onOpenChange,
}: {
  /** Which plan this is (thread and plan title), so new steps are told apart per plan. */
  planKey: string;
  text: string;
  live: boolean;
  /** Whether the whole plan is open under the line; a plan update note can open it too. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { height } = useWindowDimensions();
  const { title, items } = parseChecklist(text);
  const { fresh, markSeen } = useFreshSteps(planKey, items);
  // Closing the plan is when the person has seen the new steps.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) markSeen();
    wasOpen.current = open;
  });
  if (items.length === 0) return null;
  const { done, total } = checklistProgress(items);
  const step = items.findLast((i) => i.state === "active") ?? items.find((i) => i.state === "failed");
  const toggle = () => onOpenChange(!open);
  return (
    <View style={{ gap: 12 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        hitSlop={6}
        style={{ gap: 8 }}
      >
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
          {!open && fresh.size > 0 && <Text style={styles.badge}>{t("checklist.newSteps", { count: fresh.size })}</Text>}
          <Text style={styles.count}>
            {done} / {total}
          </Text>
          <ChevronDown size={14} color={colors.subtle} style={open ? { transform: [{ rotate: "180deg" }] } : undefined} />
        </View>
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={t("checklist.progress")}
          accessibilityValue={{ min: 0, max: total, now: done }}
          style={styles.track}
        >
          <View style={[styles.bar, { width: `${total ? (done / total) * 100 : 0}%` }]} />
        </View>
      </Pressable>
      {open && (
        <ScrollView style={{ maxHeight: height * 0.45 }}>
          <Checklist text={text} live={live} fresh={fresh} />
        </ScrollView>
      )}
    </View>
  );
}

/**
 * A note at the end of the conversation that the agent added, dropped or failed
 * plan steps while the plan card sat further up. It reads as one line; opening
 * it shows just what changed, and from there the whole plan.
 */
export function PlanUpdateNote({ update, onOpenPlan }: { update: PlanUpdate; onOpenPlan?: () => void }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const parts = [
    update.added.length > 0 && <Text style={{ color: colors.accent }}>{t("planUpdate.added", { count: update.added.length })}</Text>,
    update.removed.length > 0 && <Text>{t("planUpdate.removed", { count: update.removed.length })}</Text>,
    update.failed.length > 0 && <Text style={{ color: colors.bad }}>{t("planUpdate.failed", { count: update.failed.length })}</Text>,
  ].filter(Boolean);
  const rows = [
    ...update.added.map((s) => ({ mark: "+", text: s, style: { color: colors.fg } })),
    ...update.removed.map((s) => ({ mark: "−", text: s, style: { color: colors.subtle, textDecorationLine: "line-through" as const } })),
    ...update.failed.map((s) => ({ mark: "✗", text: s, style: { color: colors.bad } })),
  ];
  return (
    <View style={styles.cardRow}>
      {/* Lines up with the agent's messages, under its mark. */}
      <View style={{ width: 28 }} />
      <View style={styles.note}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={styles.noteHead}>
          <ListChecks size={14} color={colors.subtle} />
          <Text style={styles.noteText} numberOfLines={1}>
            {t("planUpdate.title")}
            {parts.map((p, i) => (
              <Text key={i}>
                {" · "}
                {p}
              </Text>
            ))}
          </Text>
          <ChevronDown size={14} color={colors.subtle} style={open ? { transform: [{ rotate: "180deg" }] } : undefined} />
        </Pressable>
        {open && (
          <View style={styles.noteBody}>
            {rows.map((r, i) => (
              <View key={i} style={styles.item}>
                <Text style={styles.noteMark}>{r.mark}</Text>
                <Text style={[styles.itemText, { fontSize: 14, lineHeight: 20 }, r.style]}>{r.text}</Text>
              </View>
            ))}
            {onOpenPlan && (
              <Pressable accessibilityRole="button" onPress={onOpenPlan} hitSlop={6}>
                <Text style={styles.link}>{t("planUpdate.openPlan")}</Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
    </View>
  );
}
