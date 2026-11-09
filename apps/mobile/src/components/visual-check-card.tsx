import type { MessageKey } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import type { VisualCheckAction, VisualCheckCard as Card, VisualCheckStatus } from "@myrel/protocol";
import { useMutation } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { type Href, useRouter } from "expo-router";
import { CircleAlert, CircleCheck, CircleDashed, CircleX, Copy, FileImage, ScanEye } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSession } from "../lib/session";
import { makeStyles, mono, radius, useColors } from "../theme";
import { Button, errorMessage, Spinner } from "./ui";

const SCORES = ["functionality", "craft", "design", "originality"] as const;

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * One round of a visual check (ProjectSettings.visualCheck) in the thread that asked for it, as on
 * the web: who judged it, what must change with the screenshot that shows it, and the contact sheets.
 */
export function VisualCheckCard({ card, projectId, threadId }: { card: Card; projectId: string; threadId: string }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const { api } = useSession();
  const act = useMutation({ mutationFn: (action: VisualCheckAction) => api.visualCheckAction(projectId, threadId, card.id, action) });
  const settled = card.status !== "running";
  const canAccept = settled && card.status !== "passed" && !card.acceptedBy;
  const canApprove = settled && card.status !== "not_checked" && !card.baselineBy;
  const tone: Record<VisualCheckStatus, string> = {
    running: colors.accent,
    passed: colors.ok,
    failed: colors.bad,
    partial: colors.warn,
    not_checked: colors.warn,
  };
  const color = tone[card.status];
  const Icon = card.status === "passed" ? CircleCheck : card.status === "failed" ? CircleX : card.status === "partial" ? CircleDashed : CircleAlert;
  const open = (path: string) => router.push(`/projects/${projectId}/file?path=${encodeURIComponent(path)}` as Href);

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <ScanEye size={16} color={colors.muted} />
        <Text style={styles.title}>{t("visualCheck.title", { round: card.round })}</Text>
        <View style={styles.status}>
          {card.status === "running" ? <Spinner size={14} /> : <Icon size={15} color={color} />}
          <Text style={[styles.statusText, { color }]}>{t(`visualCheck.status.${card.status}` as MessageKey)}</Text>
        </View>
      </View>

      {card.evaluator && (
        <Text style={styles.meta}>
          {t("visualCheck.judgedBy", { cli: card.evaluator.cli, model: card.evaluator.model })}
          {card.vision && card.vision !== "passed" ? ` · ${t("visualCheck.visionNotRead")}` : ""}
        </Text>
      )}
      {card.deterministic && (
        <Text style={styles.meta}>
          {t("visualCheck.deterministic", { shots: card.deterministic.shots, blocking: card.deterministic.blocking, warnings: card.deterministic.warnings })}
        </Text>
      )}
      {card.scores && <Text style={styles.meta}>{SCORES.map((k) => `${t(`visualCheck.score.${k}` as MessageKey)} ${card.scores![k]}`).join(" · ")}</Text>}
      {card.evaluatorThreadId && (
        <Pressable accessibilityRole="link" onPress={() => router.push(`/projects/${projectId}/threads/${card.evaluatorThreadId}` as Href)}>
          <Text style={styles.link}>{t("visualCheck.openEvaluator")}</Text>
        </Pressable>
      )}
      {!!card.note && <Text style={styles.note}>{card.note}</Text>}
      {!!card.command && (
        <View style={styles.command}>
          <Text selectable style={styles.commandText}>
            {card.command}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("runners.copyCommand")}
            hitSlop={10}
            onPress={() => void Clipboard.setStringAsync(card.command!)}
          >
            <Copy size={16} color={colors.subtle} />
          </Pressable>
        </View>
      )}

      {card.blocking.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={styles.section}>{t("visualCheck.mustFix")}</Text>
          {card.blocking.map((b, i) => (
            <View key={`${b.screen}-${b.evidence}-${i}`} style={styles.finding}>
              <View style={styles.findingHead}>
                <View style={styles.num}>
                  <Text style={styles.numText}>{b.n ?? i + 1}</Text>
                </View>
                <Text style={styles.screen}>{b.screen}</Text>
              </View>
              <Text style={styles.problem}>{b.problem}</Text>
              <Pressable accessibilityRole="button" onPress={() => open(b.image ?? b.evidence)} style={styles.fileLink}>
                <FileImage size={12} color={colors.link} />
                <Text style={styles.link}>{b.image ? t("visualCheck.showOnScreenshot") : fileName(b.evidence)}</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {(card.sheets.length > 0 || card.diffs.length > 0 || !!card.summary) && (
        <View style={styles.chips}>
          {!!card.summary && (
            <Pressable accessibilityRole="button" onPress={() => open(card.summary!)} style={({ pressed }) => [styles.chip, pressed && { backgroundColor: colors.hover }]}>
              <Text style={styles.chipText}>{t("visualCheck.summary")}</Text>
            </Pressable>
          )}
          {card.sheets.map((s) => (
            <Pressable key={s} accessibilityRole="button" onPress={() => open(s)} style={({ pressed }) => [styles.chip, pressed && { backgroundColor: colors.hover }]}>
              <FileImage size={12} color={colors.subtle} />
              <Text style={styles.chipText}>{fileName(s).replace(/\.sheet\.png$/, "")}</Text>
            </Pressable>
          ))}
          {card.diffs.map((d) => (
            <Pressable key={d} accessibilityRole="button" onPress={() => open(d)} style={({ pressed }) => [styles.chip, styles.diffChip, pressed && { backgroundColor: colors.hover }]}>
              <FileImage size={12} color={colors.warn} />
              <Text style={styles.chipText}>{t("visualCheck.changed", { screen: fileName(d).replace(/\.diff\.png$/, "") })}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {(!!card.acceptedBy || !!card.baselineBy) && (
        <Text style={styles.meta}>
          {[card.acceptedBy && t("visualCheck.acceptedBy", { name: card.acceptedBy }), card.baselineBy && t("visualCheck.baselineBy", { name: card.baselineBy })]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      )}
      {(canAccept || canApprove) && (
        <View style={styles.actions}>
          {canAccept && (
            <Button variant="ghost" onPress={() => act.mutate("accept")} pending={act.isPending && act.variables === "accept"}>
              {t("visualCheck.accept")}
            </Button>
          )}
          {canApprove && (
            <Button variant="ghost" onPress={() => act.mutate("baseline")} pending={act.isPending && act.variables === "baseline"}>
              {t("visualCheck.approveBaseline")}
            </Button>
          )}
        </View>
      )}
      {act.error && <Text style={[styles.meta, { color: colors.bad }]}>{errorMessage(act.error, t("common.error"))}</Text>}
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    card: { gap: 6, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.card, backgroundColor: colors.raised, padding: 14 },
    head: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { color: colors.fg, fontSize: 15, fontWeight: "600", flexShrink: 1 },
    status: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 5 },
    statusText: { fontSize: 13, fontWeight: "600" },
    meta: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    note: { color: colors.body, fontSize: 13, lineHeight: 18 },
    command: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.edge, backgroundColor: colors.panel, paddingHorizontal: 10, paddingVertical: 8 },
    commandText: { flex: 1, color: colors.fg, fontSize: 12.5, fontFamily: mono },
    section: { color: colors.fg, fontSize: 13, fontWeight: "600", marginTop: 6 },
    finding: { gap: 2 },
    findingHead: { flexDirection: "row", alignItems: "center", gap: 8 },
    num: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.bad, alignItems: "center", justifyContent: "center" },
    numText: { color: colors.onAccent, fontSize: 11, fontWeight: "700" },
    diffChip: { borderColor: colors.warnLine, backgroundColor: colors.warnSoft },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
    screen: { color: colors.subtle, fontSize: 12, fontFamily: mono },
    problem: { color: colors.body, fontSize: 14, lineHeight: 20 },
    fileLink: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2 },
    link: { color: colors.link, fontSize: 13 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
    chip: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: radius.md, borderWidth: 1, borderColor: colors.edge, backgroundColor: colors.panel, paddingHorizontal: 10, paddingVertical: 6 },
    chipText: { color: colors.fg, fontSize: 13 },
  }),
);
