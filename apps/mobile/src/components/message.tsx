import { useT } from "@myrel/i18n/react";
import {
  type Artifact,
  type Attachment,
  DECISION_LANG,
  type Message,
  parseConnectorSuggestion,
  type Reaction,
} from "@myrel/protocol";
import { CircleAlert, Paperclip } from "lucide-react-native";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius } from "../theme";
import { ArtifactCards } from "./artifact-card";
import { Collapsible } from "./collapsible";
import { ConnectorSuggestionCard } from "./connector-suggestion-card";
import { type DecisionHandlers, MessageMarkdown } from "./markdown";
import { MessageStatsLine } from "./message-stats";
import { MyrelMark, Spinner, useRelativeTime } from "./ui";

export type Names = Record<string, string>;

/** Line heights of a bubble and of markdown text, to fold after so many lines. */
const BUBBLE_LINE = 22;
const MARKDOWN_LINE = 24;

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
  artifacts,
  onLink,
  onOpenArtifact,
  children,
}: {
  message: Message;
  me: string;
  names: Names;
  reactions?: Reaction[];
  decision?: DecisionHandlers;
  artifacts: Record<string, Artifact>;
  onLink: (href: string) => void;
  onOpenArtifact: (artifactId: string, version?: number) => void;
  children?: ReactNode;
}) {
  const t = useT();
  const relativeTime = useRelativeTime();

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
    const suggestion = message.threadId ? parseConnectorSuggestion(message.body) : null;
    return (
      <View style={styles.agent}>
        <MyrelMark size={28} />
        <View style={{ flex: 1, minWidth: 0, gap: 8, paddingTop: 2 }}>
          {suggestion ? (
            <ConnectorSuggestionCard suggestion={suggestion} projectId={message.projectId} threadId={message.threadId!} />
          ) : (
            !!message.body && (
              <FoldIfLong body={message.body}>
                <MessageMarkdown body={message.body} decision={decision} onLink={onLink} />
              </FoldIfLong>
            )
          )}
          <Attachments attachments={message.attachments} />
          {!!message.artifacts?.length && (
            <ArtifactCards refs={message.artifacts} artifacts={artifacts} onOpen={onOpenArtifact} />
          )}
          {children}
          {message.stats && <MessageStatsLine stats={message.stats} />}
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
      {!mine && <Text style={styles.author}>{names[message.authorId] ?? t("common.member")}</Text>}
      {!!message.body && (
        <View style={styles.bubble}>
          <Collapsible height={BUBBLE_LINE * 10}>
            <Text selectable style={styles.bubbleText}>
              {message.body}
            </Text>
          </Collapsible>
        </View>
      )}
      <Attachments attachments={message.attachments} />
      <Reactions reactions={reactions} />
      {children && <View style={{ width: "100%" }}>{children}</View>}
    </View>
  );
}

/**
 * Agent replies fold later than people's messages, and never when they carry
 * a decision card: the card sits at the end and must stay in reach.
 */
function FoldIfLong({ body, children }: { body: string; children: ReactNode }) {
  if (body.includes("```" + DECISION_LANG)) return children;
  return <Collapsible height={MARKDOWN_LINE * 24}>{children}</Collapsible>;
}

function Attachments({ attachments }: { attachments?: Attachment[] }) {
  if (!attachments?.length) return null;
  return (
    <View style={styles.attachments}>
      {attachments.map((a) => (
        <View key={a.path} style={styles.attachment}>
          <Paperclip size={13} color={colors.subtle} />
          <Text style={styles.attachmentName} numberOfLines={1}>
            {a.name}
          </Text>
        </View>
      ))}
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

export function Thinking({ label }: { label: string }) {
  return (
    <View style={styles.agent} accessibilityRole="progressbar" accessibilityLabel={label}>
      <MyrelMark size={28} />
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 4 }}>
        <Spinner size={15} color={colors.subtle} />
        <Text style={{ color: colors.subtle, fontSize: 15, flexShrink: 1 }} numberOfLines={2}>
          {label}…
        </Text>
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
  bubbleText: { color: colors.fg, fontSize: 16, lineHeight: BUBBLE_LINE },
  attachments: { flexDirection: "row", flexWrap: "wrap", gap: 6, maxWidth: "85%" },
  attachment: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.edge,
    backgroundColor: colors.raised,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 220,
  },
  attachmentName: { color: colors.body, fontSize: 13, flexShrink: 1 },
  reaction: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.edge,
    backgroundColor: colors.raised,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
});
