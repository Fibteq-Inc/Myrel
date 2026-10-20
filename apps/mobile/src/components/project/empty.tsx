import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../../theme";

export function Empty({ icon, title, body }: { icon?: ReactNode; title: string; body?: string }) {
  return (
    <View style={styles.box}>
      {icon}
      <Text style={styles.title}>{title}</Text>
      {body && <Text style={styles.body}>{body}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 32, paddingVertical: 48 },
  title: { color: colors.fg, fontSize: 17, fontWeight: "600", textAlign: "center" },
  body: { color: colors.subtle, fontSize: 14, lineHeight: 20, textAlign: "center" },
});
