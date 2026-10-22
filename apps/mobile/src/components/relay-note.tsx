import { useT } from "@myrel/i18n/react";
import type { MessageRelay } from "@myrel/protocol";
import { ChevronDown } from "lucide-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius } from "../theme";
import { MessageMarkdown } from "./markdown";

/** A note this long starts folded inside the open box, so it never takes over the chat. */
const LONG_NOTE_CHARS = 1200;
const LONG_NOTE_LINES = 12;

/**
 * What the coordinator sent a thread, folded under the line that announces it, so people can check
 * that their message went through and what was said.
 */
export function RelayNote({ relay, onLink }: { relay: MessageRelay; onLink: (href: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const long = relay.note.length > LONG_NOTE_CHARS || relay.note.split("\n").length > LONG_NOTE_LINES;
  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [styles.toggle, pressed && { backgroundColor: colors.hover }]}
      >
        <Text style={styles.toggleText}>{open ? t("relay.hide") : t("relay.show")}</Text>
        <ChevronDown size={13} color={colors.muted} style={open ? { transform: [{ rotate: "180deg" }] } : undefined} />
      </Pressable>
      {open && (
        <View style={styles.box}>
          <Text style={styles.kind}>{t(`relay.kind.${relay.kind}`)}</Text>
          <View style={long && !full ? styles.folded : undefined}>
            <MessageMarkdown body={relay.note} onLink={onLink} />
          </View>
          {long && (
            <Pressable accessibilityRole="button" onPress={() => setFull((f) => !f)} hitSlop={8}>
              <Text style={styles.more}>{full ? t("relay.less") : t("relay.more")}</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "flex-start", gap: 8 },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: colors.edge,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  toggleText: { color: colors.muted, fontSize: 12 },
  box: {
    alignSelf: "stretch",
    borderWidth: 1,
    borderColor: "#2b3060",
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  kind: { color: colors.subtle, fontSize: 12 },
  folded: { maxHeight: 220, overflow: "hidden" },
  more: { color: colors.accent, fontSize: 12, paddingTop: 2 },
});
