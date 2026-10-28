import { computerTipDue, DOCS_URL, decisionTipDue } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { Me, Thread, TipId } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { Laptop } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { runnersQueryKey } from "../lib/queries";
import { useSession } from "../lib/session";
import { makeStyles, radius, useColors } from "../theme";

/** The account, with the one-time tips it has seen, and how to mark one seen (at once, on every device). */
function useTips() {
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const meKey = ["me", server];
  const me = useQuery({ queryKey: meKey, queryFn: () => api.getMe() });
  const see = useMutation({
    mutationFn: (tip: TipId) => api.markTipSeen(tip),
    onMutate: (tip) => queryClient.setQueryData<Me>(meKey, (old) => old && { ...old, tips: [...(old.tips ?? []), tip] }),
  }).mutate;
  return { tips: me.data?.tips, see };
}

/** Whether a decision card the person can answer carries the note, and how to put it away. */
export function useDecisionTip() {
  const { tips, see } = useTips();
  return { due: decisionTipDue(tips), seen: () => see("decision") };
}

/** The note under the first decision card the person can answer. */
export function DecisionTip({ onSeen }: { onSeen: () => void }) {
  const t = useT();
  const styles = useStyles();
  return (
    <View style={styles.note}>
      <Text style={styles.noteText}>{t("tip.decision")}</Text>
      <Pressable accessibilityRole="button" hitSlop={8} onPress={onSeen}>
        <Text style={styles.subtle}>{t("tip.decision.ok")}</Text>
      </Pressable>
    </View>
  );
}

/**
 * After the project's first finished thread, once: offer pairing a computer to someone who has none.
 * Pairing happens on a computer, so the phone opens the guide.
 */
export function ComputerTip({ threads }: { threads: Thread[] }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const { tips, see } = useTips();
  const runners = useQuery({
    queryKey: runnersQueryKey(server),
    queryFn: () => api.listRunners(),
    enabled: !!tips && !tips.includes("computer"),
  });
  if (!runners.data || !computerTipDue({ tips, computers: runners.data.length, threads })) return null;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Laptop size={16} color={colors.accent} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={styles.title}>{t("tip.computer.title")}</Text>
          <Text style={styles.body}>{t("tip.computer.body")}</Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" hitSlop={8} onPress={() => see("computer")}>
          <Text style={styles.subtle}>{t("tip.computer.later")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="link"
          onPress={() => {
            see("computer");
            void WebBrowser.openBrowserAsync(`${DOCS_URL}/computer/connect/`);
          }}
          style={({ pressed }) => [styles.button, pressed && { backgroundColor: colors.hover }]}
        >
          <Text style={styles.buttonText}>{t("starter.how")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    note: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
    noteText: { flex: 1, color: colors.muted, fontSize: 13, lineHeight: 18 },
    subtle: { color: colors.subtle, fontSize: 13 },
    card: {
      gap: 10,
      marginTop: 8,
      marginHorizontal: 12,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.panel,
      borderRadius: radius.md,
      padding: 14,
    },
    head: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
    title: { color: colors.fg, fontSize: 14, fontWeight: "600" },
    body: { color: colors.muted, fontSize: 13, lineHeight: 18 },
    actions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 16 },
    button: { borderWidth: 1, borderColor: colors.edge, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 5 },
    buttonText: { color: colors.fg, fontSize: 13 },
  }),
);
