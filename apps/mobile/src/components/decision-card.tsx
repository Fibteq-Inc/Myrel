import { useT } from "@altair/i18n/react";
import * as Haptics from "expo-haptics";
import { CircleCheck, CircleHelp } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { chosenOption, type Decision } from "../lib/decision";
import { colors, radius } from "../theme";

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
  const answered = answer !== undefined;
  const chosen = chosenOption(decision, answer);

  return (
    <View accessibilityRole="none" style={[styles.card, answered ? styles.cardAnswered : styles.cardOpen]}>
      <View style={styles.kicker}>
        {answered ? <CircleCheck size={15} color={colors.subtle} /> : <CircleHelp size={15} color={colors.warn} />}
        <Text style={{ fontSize: 13, color: answered ? colors.subtle : colors.warn }}>
          {answered ? t("decision.answered") : t("decision.yourCall")}
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

const styles = StyleSheet.create({
  card: { gap: 12, borderRadius: radius.lg, borderWidth: 1, padding: 14 },
  cardOpen: { borderColor: colors.warnLine, backgroundColor: colors.warnSoft },
  cardAnswered: { borderColor: colors.line, backgroundColor: colors.raised },
  kicker: { flexDirection: "row", alignItems: "center", gap: 8 },
  question: { color: colors.fg, fontSize: 16, fontWeight: "600", lineHeight: 22 },
  option: { gap: 3, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  optionPlain: { borderColor: "#2e2e34", backgroundColor: "#1a1a1e" },
  optionRecommended: { borderColor: colors.warn, backgroundColor: "#221e12" },
  optionPicked: { borderColor: "rgba(139,155,255,0.6)", backgroundColor: colors.accentSoft },
  optionFaded: { borderColor: colors.line, opacity: 0.6 },
  optionHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  optionLabel: { color: colors.fg, fontSize: 15, fontWeight: "600" },
  recommended: { color: colors.warn, fontSize: 13 },
  consequence: { color: colors.muted, fontSize: 14, lineHeight: 20 },
});
