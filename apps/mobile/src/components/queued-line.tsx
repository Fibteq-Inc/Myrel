import { useT } from "@myrel/i18n/react";
import { Clock, Square } from "lucide-react-native";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { makeStyles, radius, useColors } from "../theme";
import { errorMessage } from "./ui";

/**
 * Under a person's message the thread's agent has not taken in yet: it says the message waits, and
 * offers to stop the running turn so it goes now. The line goes away once the agent takes it in.
 */
export function QueuedLine({ onInterrupt }: { onInterrupt: () => Promise<unknown> }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const interrupt = () =>
    Alert.alert(t("message.interruptTitle"), t("message.interruptConfirm"), [
      { text: t("mobile.cancel"), style: "cancel" },
      {
        text: t("message.interrupt"),
        style: "destructive",
        onPress: () => {
          setBusy(true);
          onInterrupt().catch((err: unknown) => {
            setBusy(false);
            Alert.alert(t("message.interruptFailed"), errorMessage(err, t("common.error")));
          });
        },
      },
    ]);
  return (
    <View style={styles.line}>
      <View style={styles.part} accessible accessibilityLabel={`${t("message.queued")}. ${t("message.queuedHint")}`}>
        <Clock size={12} color={colors.subtle} />
        <Text style={styles.text}>{t("message.queued")}</Text>
      </View>
      <Text style={styles.text}>·</Text>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={interrupt}
        hitSlop={8}
        style={({ pressed }) => [styles.part, styles.button, pressed && { backgroundColor: colors.hover }, busy && { opacity: 0.5 }]}
      >
        <Square size={10} color={colors.muted} />
        <Text style={[styles.text, { color: colors.muted }]}>{t("message.interrupt")}</Text>
      </Pressable>
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 6 },
  part: { flexDirection: "row", alignItems: "center", gap: 4 },
  button: { borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 2 },
  text: { color: colors.subtle, fontSize: 12 },
  }),
);
