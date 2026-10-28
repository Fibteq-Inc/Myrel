import { useT } from "@myrel/i18n/react";
import * as Haptics from "expo-haptics";
import { CircleCheck, CircleHelp, TriangleAlert } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { chosenOption, type Decision } from "../lib/decision";
import { makeStyles, radius, useColors } from "../theme";

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
  /** The reply that answered it, if any. */
  answer?: string;
  /** Missing when the viewer cannot answer here. */
  onChoose?: (label: string) => void;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const answered = answer !== undefined;
  const chosen = chosenOption(decision, answer);
  const danger = !!decision.danger;

  // Answered: one line with the question and the pick, so the conversation moves on.
  if (answered) {
    const picked = chosen >= 0 ? decision.options[chosen]!.label : answer;
    return (
      <View accessibilityRole="none" style={[styles.compact, styles.cardAnswered]}>
        <CircleCheck size={15} color={colors.accent} accessibilityLabel={t("decision.answered")} />
        <Text style={styles.compactQuestion}>{decision.question}</Text>
        <Text style={styles.compactPick} accessibilityLabel={`${t("decision.chosen")}: ${picked}`}>
          {picked.length > 80 ? `${picked.slice(0, 80)}…` : picked}
        </Text>
      </View>
    );
  }

  return (
    <View accessibilityRole="none" style={[styles.card, answered ? styles.cardAnswered : danger ? styles.cardDanger : styles.cardOpen]}>
      <View style={styles.kicker}>
        {answered ? (
          <CircleCheck size={15} color={colors.subtle} />
        ) : danger ? (
          <TriangleAlert size={15} color={colors.bad} />
        ) : (
          <CircleHelp size={15} color={colors.warn} />
        )}
        <Text style={{ fontSize: 13, color: answered ? colors.subtle : danger ? colors.bad : colors.warn }}>
          {answered ? t("decision.answered") : danger ? t("decision.danger") : t("decision.yourCall")}
        </Text>
      </View>
      <Text style={styles.question}>{decision.question}</Text>
      <View style={{ gap: 8 }}>
        {decision.options.map((option, i) => {
          const recommended = i === decision.recommended;
          const picked = i === chosen;
          return (
            <Pressable
              key={option.label}
              accessibilityRole="button"
              accessibilityState={{ disabled: answered || !onChoose, selected: picked }}
              accessibilityHint={recommended ? t("decision.recommended") : undefined}
              disabled={answered || !onChoose}
              onPress={() => {
                void Haptics.selectionAsync();
                onChoose?.(option.label);
              }}
              style={({ pressed }) => [
                styles.option,
                answered
                  ? picked
                    ? styles.optionPicked
                    : styles.optionFaded
                  : recommended
                    ? styles.optionRecommended
                    : styles.optionPlain,
                pressed && { opacity: 0.75 },
              ]}
            >
              <View style={styles.optionHead}>
                <Text style={styles.optionLabel}>{option.label}</Text>
                {recommended && <Text style={styles.recommended}>{t("decision.recommended")}</Text>}
                {picked && (
                  <View style={{ marginLeft: "auto" }}>
                    <CircleCheck size={15} color={colors.accent} accessibilityLabel={t("decision.chosen")} />
                  </View>
                )}
              </View>
              {!!option.consequence && <Text style={styles.consequence}>{option.consequence}</Text>}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    card: { gap: 12, borderRadius: radius.lg, borderWidth: 1, padding: 14 },
    cardOpen: { borderColor: colors.warnLine, backgroundColor: colors.warnSoft },
    cardDanger: { borderColor: colors.bad, backgroundColor: colors.badSoft },
    cardAnswered: { borderColor: colors.line, backgroundColor: colors.raised },
    compact: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      columnGap: 8,
      rowGap: 4,
      borderRadius: radius.lg,
      borderWidth: 1,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    compactQuestion: { flexShrink: 1, color: colors.muted, fontSize: 14, lineHeight: 20 },
    compactPick: { marginLeft: "auto", color: colors.fg, fontSize: 14, fontWeight: "600" },
    kicker: { flexDirection: "row", alignItems: "center", gap: 8 },
    question: { color: colors.fg, fontSize: 16, fontWeight: "600", lineHeight: 22 },
    option: { gap: 3, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
    optionPlain: { borderColor: colors.frame, backgroundColor: colors.option },
    optionRecommended: { borderColor: colors.warn, backgroundColor: colors.warnStrong },
    optionPicked: { borderColor: colors.accentBorder, backgroundColor: colors.accentSoft },
    optionFaded: { borderColor: colors.line, opacity: 0.6 },
    optionHead: { flexDirection: "row", alignItems: "center", gap: 8 },
    optionLabel: { color: colors.fg, fontSize: 15, fontWeight: "600" },
    recommended: { color: colors.warn, fontSize: 13 },
    consequence: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  }),
);
