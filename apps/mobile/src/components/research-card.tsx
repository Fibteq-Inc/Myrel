import type { MessageKey } from "@myrel/i18n";
import { useI18n } from "@myrel/i18n/react";
import type { ResearchCard as Card, ResearchStatus } from "@myrel/protocol";
import { useMutation } from "@tanstack/react-query";
import { type Href, useRouter } from "expo-router";
import { Search } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { formatCost } from "../lib/format";
import { useSession } from "../lib/session";
import { makeStyles, radius, useColors } from "../theme";
import { Button, errorMessage } from "./ui";

/** The time now, once a minute while `live`. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [live]);
  return now;
}

/**
 * A research by Claude in its thread, as on the web: spend against its budget, searches and pages,
 * its last steps while it runs, and at the end its short answer with the report. Stop ends it with
 * what it has written so far.
 */
export function ResearchCard({ card, projectId }: { card: Card; projectId: string }) {
  const { t, locale } = useI18n();
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const { api } = useSession();
  const live = card.status === "running";
  const now = useNow(live);
  const [confirming, setConfirming] = useState(false);
  const stop = useMutation({ mutationFn: () => api.researchAction(projectId, card.id, "stop"), onSuccess: () => setConfirming(false) });
  const tone: Record<ResearchStatus, string> = { running: colors.accent, budget: colors.warn, done: colors.ok, failed: colors.bad };
  const color = card.partial ? colors.warn : tone[card.status];
  const usd = (cents: number) => formatCost(cents * 10_000, locale);
  const share = Math.min(100, (card.spentCents / card.budgetCents) * 100);
  const minutes = Math.max(1, Math.round(((card.endedAt ? Date.parse(card.endedAt) : now) - Date.parse(card.startedAt)) / 60_000));
  const status = card.status === "done" && card.partial ? t(`research.partial.${card.partial}` as MessageKey) : t(`research.status.${card.status}` as MessageKey);
  const by = [card.approverName && t("research.approvedBy", { name: card.approverName }), card.stoppedBy && t("research.stoppedBy", { name: card.stoppedBy })]
    .filter(Boolean)
    .join(". ");
  const canStop = (card.status === "running" || card.status === "budget") && !card.stoppedBy;

  return (
    <View style={styles.card} accessibilityLabel={t("research.cardLabel", { title: card.title })}>
      <View style={styles.head}>
        <Search size={16} color={colors.muted} />
        <Text style={styles.title} numberOfLines={1}>
          {card.title}
        </Text>
        <View style={styles.status}>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text style={[styles.statusText, { color }]}>{status}</Text>
        </View>
      </View>

      <View style={styles.meterRow}>
        <Text style={styles.meta}>{t("research.spent")}</Text>
        <Text style={styles.amount}>
          {usd(card.spentCents)} / {usd(card.budgetCents)}
        </Text>
      </View>
      <View style={styles.bar} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: card.budgetCents, now: card.spentCents }}>
        <View style={[styles.fill, { width: `${share}%`, backgroundColor: color }]} />
      </View>

      <Text style={styles.counts}>
        {[t("research.searches", { count: card.searches }), t("research.pages", { count: card.pages }), t("research.minutes", { count: minutes })].join("   ")}
      </Text>

      {live && card.steps.length > 0 && (
        <View style={styles.steps}>
          {card.steps.map((step, i) => (
            <View key={`${step.kind}-${step.text}-${i}`} style={styles.step}>
              <Text style={styles.stepKind}>{t(`research.step.${step.kind}` as MessageKey)}</Text>
              {step.kind === "read" ? (
                <Text style={styles.link} numberOfLines={1} onPress={() => void Linking.openURL(step.text).catch(() => {})}>
                  {step.text.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </Text>
              ) : (
                <Text style={styles.stepText} numberOfLines={1}>
                  {step.text}
                </Text>
              )}
            </View>
          ))}
        </View>
      )}

      {card.status === "budget" && <Text style={styles.box}>{t("research.waitingBudget")}</Text>}
      {!!card.summary && <Text style={styles.box}>{card.summary}</Text>}
      {!!card.note && card.status === "failed" && <Text style={[styles.meta, { color: colors.bad }]}>{card.note}</Text>}
      {!!by && <Text style={styles.meta}>{by}</Text>}

      {(card.report || canStop) && (
        <View style={styles.actions}>
          {card.report && (
            <Button onPress={() => router.push(`/projects/${projectId}/file?path=${encodeURIComponent(card.report!)}` as Href)}>{t("research.openReport")}</Button>
          )}
          {canStop &&
            (confirming ? (
              <View style={{ gap: 6, flex: 1 }}>
                <Text style={styles.meta}>{t("research.stopHint")}</Text>
                <Pressable accessibilityRole="button" disabled={stop.isPending} onPress={() => stop.mutate()} style={[styles.chip, styles.stopChip]}>
                  <Text style={styles.chipText}>{t("research.stopSure")}</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable accessibilityRole="button" onPress={() => setConfirming(true)} style={styles.chip}>
                <Text style={styles.chipText}>{t("research.stop")}</Text>
              </Pressable>
            ))}
        </View>
      )}
      {stop.error && <Text style={[styles.meta, { color: colors.bad }]}>{errorMessage(stop.error, t("common.error"))}</Text>}
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    card: { gap: 8, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.card, backgroundColor: colors.raised, padding: 14 },
    head: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { color: colors.fg, fontSize: 15, fontWeight: "600", flexShrink: 1 },
    status: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    statusText: { fontSize: 13, fontWeight: "600" },
    meterRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
    meta: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    amount: { color: colors.body, fontSize: 13, fontWeight: "500", fontVariant: ["tabular-nums"] },
    bar: { height: 6, borderRadius: 3, backgroundColor: colors.bubble, overflow: "hidden" },
    fill: { height: 6, borderRadius: 3 },
    counts: { color: colors.muted, fontSize: 13 },
    steps: { gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingTop: 8 },
    step: { flexDirection: "row", gap: 8 },
    stepKind: { width: 56, color: colors.subtle, fontSize: 13 },
    stepText: { flex: 1, color: colors.body, fontSize: 13 },
    link: { flex: 1, color: colors.link, fontSize: 13 },
    box: { color: colors.body, fontSize: 13, lineHeight: 19, backgroundColor: colors.bubble, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8 },
    actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 2 },
    chip: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.edge, backgroundColor: colors.panel, paddingHorizontal: 12, paddingVertical: 8, alignSelf: "flex-start" },
    stopChip: { borderColor: colors.bad, backgroundColor: colors.badSoft },
    chipText: { color: colors.fg, fontSize: 14 },
  }),
);
