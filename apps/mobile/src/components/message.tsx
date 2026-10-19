import type { Message, Reaction } from "@altair/protocol";
import { CircleAlert } from "lucide-react-native";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius } from "../theme";
import { type DecisionHandlers, MessageMarkdown } from "./markdown";
import { AltairMark, relativeTime, Spinner } from "./ui";

export type Names = Record<string, string>;

/**
 * One message, Claude style: people's messages as bubbles on the right,
 * the assistant's as open text beside its mark, system notes as a banner.
 * `children` renders under the message (e.g. its thread card).
 */
export function MessageView({
  message,
  me,
  names,
  reactions,
  decision,
  onLink,
  children,
}: {
  message: Message;
  me: string;
  names: Names;
  reactions?: Reaction[];
  decision?: DecisionHandlers;
  onLink: (href: string) => void;
  children?: ReactNode;
}) {
  if (message.authorKind === "system") {
    return (
      <View style={styles.system}>
        <CircleAlert size={16} color={colors.warn} style={{ marginTop: 2 }} />
        <Text selectable style={styles.systemText}>
          {message.body}
        </Text>
      </View>
    );
  }

  if (message.authorKind === "agent") {
    return (
      <View style={styles.agent}>
        <AltairMark size={28} />
        <View style={{ flex: 1, minWidth: 0, gap: 8, paddingTop: 2 }}>
          <MessageMarkdown body={message.body} decision={decision} onLink={onLink} />
          {children}
          <View style={styles.meta}>
            <Reactions reactions={reactions} />
            <Text style={styles.time}>{relativeTime(message.createdAt)}</Text>
          </View>
        </View>
      </View>
    );
  }

  const mine = message.authorId === me;
  return (
    <View style={styles.user}>
      {!mine && <Text style={styles.author}>{names[message.authorId] ?? "Member"}</Text>}
      <View style={styles.bubble}>
        <Text selectable style={styles.bubbleText}>
          {message.body}
        </Text>
      </View>
      <Reactions reactions={reactions} />
      {children && <View style={{ width: "100%" }}>{children}</View>}
    </View>
  );
}

function Reactions({ reactions }: { reactions?: Reaction[] }) {
  if (!reactions?.length) return null;
  const counts = new Map<string, number>();
  for (const r of reactions) counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);
  return (
    <View style={{ flexDirection: "row", gap: 4 }}>
      {[...counts].map(([emoji, n]) => (
        <View key={emoji} style={styles.reaction}>
          <Text style={{ fontSize: 13 }}>
            {emoji}
            {n > 1 && <Text style={{ color: colors.subtle }}> {n}</Text>}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function Thinking({ label = "Thinking" }: { label?: string }) {
  return (
    <View style={styles.agent} accessibilityRole="progressbar" accessibilityLabel={label}>
      <AltairMark size={28} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Spinner size={15} color={colors.subtle} />
        <Text style={{ color: colors.subtle, fontSize: 15 }}>{label}…</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  system: {
    flexDirection: "row",
    gap: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warnLine,
    backgroundColor: colors.warnSoft,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  systemText: { flex: 1, color: colors.body, fontSize: 14, lineHeight: 20 },
  agent: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  meta: { flexDirection: "row", alignItems: "center", gap: 8 },
  time: { color: colors.subtle, fontSize: 12 },
  user: { alignItems: "flex-end", gap: 6 },
  author: { color: colors.subtle, fontSize: 12 },
  bubble: {
    maxWidth: "85%",
    borderRadius: 18,
    borderBottomRightRadius: 6,
    borderWidth: 1,
    borderColor: colors.edge,
    backgroundColor: colors.bubble,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleText: { color: colors.fg, fontSize: 16, lineHeight: 22 },
  reaction: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.edge,
    backgroundColor: colors.raised,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
});
