import { useT } from "@myrel/i18n/react";
import { ArrowUp } from "lucide-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { makeStyles, useColors, useTheme } from "../theme";

/** Message box pinned to the bottom of a conversation. */
export function Composer({
  placeholder,
  onSend,
  disabled,
}: {
  placeholder: string;
  onSend: (body: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const theme = useTheme();
  const colors = useColors();
  const styles = useStyles();
  const [body, setBody] = useState("");
  const canSend = body.trim().length > 0 && !disabled;

  function send() {
    if (!canSend) return;
    onSend(body.trim());
    setBody("");
  }

  return (
    <View style={styles.box}>
      <TextInput
        value={body}
        onChangeText={setBody}
        placeholder={placeholder}
        placeholderTextColor={colors.subtle}
        multiline
        keyboardAppearance={theme}
        style={styles.input}
        accessibilityLabel={placeholder}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("composer.send")}
        disabled={!canSend}
        onPress={send}
        style={[styles.send, !canSend && { opacity: 0.4 }]}
      >
        {/* White reads on the send fill in both themes. */}
        <ArrowUp size={20} color="#ffffff" />
      </Pressable>
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    box: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
      marginHorizontal: 12,
      marginBottom: 8,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: colors.edge,
      backgroundColor: colors.raised,
      paddingLeft: 16,
      paddingRight: 8,
      paddingVertical: 8,
    },
    input: { flex: 1, maxHeight: 140, minHeight: 36, color: colors.fg, fontSize: 16, paddingTop: 8, paddingBottom: 8 },
    send: {
      width: 40,
      height: 40,
      borderRadius: 14,
      backgroundColor: colors.send,
      alignItems: "center",
      justifyContent: "center",
    },
  }),
);
