import { useT } from "@myrel/i18n/react";
import { Square } from "lucide-react-native";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text } from "react-native";
import { makeStyles, radius, useColors } from "../theme";
import { errorMessage } from "./ui";

/**
 * Next to a thread's "Working" line: stops its agent's turn, and anything waiting to continue it.
 * A message written meanwhile goes to the running agent rather than stopping it, so this is the
 * way to stop it from the chat.
 */
export function StopButton({ onStop }: { onStop: () => Promise<unknown> }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const stop = () =>
    Alert.alert(t("message.stopTitle"), t("message.stopConfirm"), [
      { text: t("mobile.cancel"), style: "cancel" },
      {
        text: t("message.stop"),
        style: "destructive",
        onPress: () => {
          setBusy(true);
          onStop().catch((err: unknown) => {
            setBusy(false);
            Alert.alert(t("message.stopFailed"), errorMessage(err, t("common.error")));
          });
        },
      },
    ]);
  return (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={stop}
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && { backgroundColor: colors.hover }, busy && { opacity: 0.5 }]}
    >
      <Square size={11} color={colors.muted} />
      <Text style={styles.text}>{t("message.stop")}</Text>
    </Pressable>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    button: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4 },
    text: { color: colors.muted, fontSize: 13 },
  }),
);
