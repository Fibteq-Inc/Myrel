import { useT } from "@myrel/i18n/react";
import * as Haptics from "expo-haptics";
import { CircleCheck, CircleHelp, TriangleAlert } from "lucide-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { chosenOption, type Decision, type DecisionAnswer } from "../lib/decision";
import { makeStyles, radius, useColors } from "../theme";
import { DecisionTip, useDecisionTip } from "./tips";

/**
 * A question with 2 to 4 options, one recommended. One tap sends the option's
 * label as the person's reply. Once answered, the card shows the pick.
 */
export function DecisionCard({
  decision,
  answer,
  onChoose,
}: {
  decision: Decision;
  /** The reply that answered it; null when a message of the person's closed several cards at once. */
  answer?: DecisionAnswer;
  /** Missing when the viewer cannot answer here. */
  onChoose?: (label: string) => void;
}) {
  const t = useT();
  const styles = useStyles();
  const danger = !!decision.danger;
  const tip = useDecisionTip();
  const showTip = tip.due && answer === undefined && !!onChoose;

  // Answered: one line with the question and the pick, so the conversation moves on.
  if (answer !== undefined) {
    return (
      <View accessibilityRole="none" style={[styles.compact, styles.cardAnswered]}>
        <AnsweredLine decision={decision} answer={answer} />
      </View>
    );
  }

  return (
    <View accessibilityRole="none" style={[styles.card, danger ? styles.cardDanger : styles.cardOpen]}>
      <Kicker danger={danger} />
      <Text style={styles.question}>{decision.question}</Text>
      <OptionList
        decision={decision}
        onPick={
          onChoose &&
          ((label) => {
            if (showTip) tip.seen();
            onChoose(label);
          })
        }
      />
      {showTip && <DecisionTip onSeen={tip.seen} />}
    </View>
  );
}

/**
 * Questions an agent asked together, answered one by one in a single card: the answered ones as a
 * line each on top, the current one with its options, the ones still to come by their question.
 * Each tap goes as the person's reply to that question alone.
 */
export function DecisionSteps({
  decisions,
  answers,
  onChoose,
}: {
  decisions: Decision[];
  /** What answered each question, in order (decisionState); undefined while open. */
  answers?: readonly (DecisionAnswer | undefined)[];
  /** `card`: which of the questions the option is on. Missing when the viewer cannot answer here. */
  onChoose?: (label: string, card: number) => void;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const tip = useDecisionTip();
  // A tap moves on to the next question at once, before its message comes back from the server.
  const [tapped, setTapped] = useState<Record<number, string>>({});
  const given = decisions.map((_, i) => (answers?.[i] !== undefined ? answers[i] : tapped[i]));
  const current = given.findIndex((a) => a === undefined);
  const lines = decisions.flatMap((decision, i) => {
    const answer = given[i];
    return answer === undefined ? [] : [<AnsweredLine key={i} decision={decision} answer={answer} />];
  });

  // Every question answered: their lines, so the conversation moves on.
  if (current < 0) return <View style={[styles.lines, styles.cardAnswered]}>{lines}</View>;

  const decision = decisions[current]!;
  const danger = !!decision.danger;
  const showTip = tip.due && !!onChoose;
  return (
    <View accessibilityRole="none" style={[styles.card, danger ? styles.cardDanger : styles.cardOpen]}>
      <View style={styles.kickerRow}>
        <Kicker danger={danger} step={t("decision.step", { n: current + 1, total: decisions.length })} />
        <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {decisions.map((_, i) => (
            <View
              key={i}
              style={[styles.dot, { backgroundColor: given[i] !== undefined || i === current ? colors.warn : colors.warnLine }]}
            />
          ))}
        </View>
      </View>
      {lines.length > 0 && <View style={styles.answeredBox}>{lines}</View>}
      <Text style={styles.question} accessibilityLiveRegion="polite">
        {decision.question}
      </Text>
      <OptionList
        key={current}
        decision={decision}
        onPick={
          onChoose &&
          ((label) => {
            if (showTip) tip.seen();
            setTapped((was) => ({ ...was, [current]: label }));
            onChoose(label, current);
          })
        }
      />
      {decisions.map((next, i) =>
        i > current && given[i] === undefined ? (
          <View key={i} style={styles.upcoming}>
            <Text style={styles.upcomingText}>
              {i + 1}. {next.question}
            </Text>
          </View>
        ) : null,
      )}
      {showTip && <DecisionTip onSeen={tip.seen} />}
    </View>
  );
}

/** "Your call" (or the warning for a step that cannot be undone), with the step when it has one. */
function Kicker({ danger, step }: { danger: boolean; step?: string }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const label = danger ? t("decision.danger") : t("decision.yourCall");
  return (
    <View style={styles.kicker}>
      {danger ? <TriangleAlert size={15} color={colors.bad} /> : <CircleHelp size={15} color={colors.warn} />}
      <Text style={{ fontSize: 13, color: danger ? colors.bad : colors.warn }}>{step ? `${label} · ${step}` : label}</Text>
    </View>
  );
}

/** One answered question: the question and the pick (or that a message answered it). */
function AnsweredLine({ decision, answer }: { decision: Decision; answer: DecisionAnswer }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const chosen = chosenOption(decision, answer);
  const picked = chosen >= 0 ? decision.options[chosen]!.label : (answer ?? t("decision.inMessage"));
  return (
    <View style={styles.line}>
      <CircleCheck size={15} color={colors.accent} accessibilityLabel={t("decision.answered")} />
      <Text style={styles.compactQuestion}>{decision.question}</Text>
      <Text
        style={answer === null ? styles.compactNone : styles.compactPick}
        accessibilityLabel={answer === null ? picked : `${t("decision.chosen")}: ${picked}`}
      >
        {picked.length > 80 ? `${picked.slice(0, 80)}…` : picked}
      </Text>
    </View>
  );
}

/** A question's options; the recommended one stands out. Without `onPick` they cannot be tapped. */
function OptionList({ decision, onPick }: { decision: Decision; onPick?: (label: string) => void }) {
  const t = useT();
  const styles = useStyles();
  return (
    <View style={{ gap: 8 }}>
      {decision.options.map((option, i) => {
        const recommended = i === decision.recommended;
        return (
          <Pressable
            key={option.label}
            accessibilityRole="button"
            accessibilityState={{ disabled: !onPick }}
            accessibilityHint={recommended ? t("decision.recommended") : undefined}
            disabled={!onPick}
            onPress={() => {
              void Haptics.selectionAsync();
              onPick?.(option.label);
            }}
            style={({ pressed }) => [styles.option, recommended ? styles.optionRecommended : styles.optionPlain, pressed && { opacity: 0.75 }]}
          >
            <View style={styles.optionHead}>
              <Text style={styles.optionLabel}>{option.label}</Text>
              {recommended && <Text style={styles.recommended}>{t("decision.recommended")}</Text>}
            </View>
            {!!option.consequence && <Text style={styles.consequence}>{option.consequence}</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    card: { gap: 12, borderRadius: radius.lg, borderWidth: 1, padding: 14 },
    cardOpen: { borderColor: colors.warnLine, backgroundColor: colors.warnSoft },
    cardDanger: { borderColor: colors.bad, backgroundColor: colors.badSoft },
    cardAnswered: { borderColor: colors.line, backgroundColor: colors.raised },
    compact: { borderRadius: radius.lg, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10 },
    lines: { gap: 8, borderRadius: radius.lg, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10 },
    answeredBox: {
      gap: 6,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.raised,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    line: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 4 },
    compactQuestion: { flexShrink: 1, color: colors.muted, fontSize: 14, lineHeight: 20 },
    compactPick: { marginLeft: "auto", color: colors.fg, fontSize: 14, fontWeight: "600" },
    compactNone: { marginLeft: "auto", color: colors.subtle, fontSize: 14 },
    kickerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    kicker: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
    dots: { marginLeft: "auto", flexDirection: "row", gap: 4 },
    dot: { width: 16, height: 4, borderRadius: 2 },
    question: { color: colors.fg, fontSize: 16, fontWeight: "600", lineHeight: 22 },
    upcoming: {
      borderRadius: radius.md,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.frame,
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    upcomingText: { color: colors.subtle, fontSize: 14, lineHeight: 20 },
    option: { gap: 3, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
    optionPlain: { borderColor: colors.frame, backgroundColor: colors.option },
    optionRecommended: { borderColor: colors.warn, backgroundColor: colors.warnStrong },
    optionHead: { flexDirection: "row", alignItems: "center", gap: 8 },
    optionLabel: { color: colors.fg, fontSize: 15, fontWeight: "600" },
    recommended: { color: colors.warn, fontSize: 13 },
    consequence: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  }),
);
