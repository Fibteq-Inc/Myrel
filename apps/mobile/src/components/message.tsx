import { useI18n, useT } from "@myrel/i18n/react";
import {
  type Artifact,
  type Attachment,
  DECISION_LANG,
  type Message,
  parseConnectorSuggestion,
  type Reaction,
} from "@myrel/protocol";
import { type Href, useRouter } from "expo-router";
import { CircleAlert, FileImage, Paperclip, Pencil } from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { fileKind } from "../lib/files";
import { surelyLong } from "../lib/fold";
import { formatBytes } from "../lib/format";
import { makeStyles, radius, useColors, useTheme } from "../theme";
import { ArtifactCards } from "./artifact-card";
import { Collapsible } from "./collapsible";
import { ConnectorSuggestionCard } from "./connector-suggestion-card";
import { type DecisionHandlers, MessageMarkdown } from "./markdown";
import { MessageStatsLine } from "./message-stats";
import { QueuedLine } from "./queued-line";
import { RelayNote } from "./relay-note";
import { StopButton } from "./stop-button";
import { CliMark, Spinner, useRelativeTime } from "./ui";

export type Names = Record<string, string>;

/** Line heights of a bubble and of markdown text, to fold after so many lines. */
const BUBBLE_LINE = 22;
const MARKDOWN_LINE = 24;

/**
 * One message, Claude style: people's messages as bubbles on the right,
 * the assistant's as open text beside its mark, system notes as a banner.
 * `children` renders under the message (e.g. its thread card). `onEdit` lets the
 * person change their own message's text. `onInterrupt`: the message waits for the
 * thread's working agent, which this stops so it goes now.
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
  onEdit,
  onInterrupt,
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
  onEdit?: (body: string) => void;
  onInterrupt?: () => Promise<unknown>;
  children?: ReactNode;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
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
        {/* In a thread, the mark of the CLI that wrote it. */}
        <CliMark cli={message.threadId ? (message.stats?.task?.harness ?? message.stats?.harness) : null} tile />
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
          {message.relay && <RelayNote relay={message.relay} onLink={onLink} />}
          <Attachments projectId={message.projectId} attachments={message.attachments} />
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

  return (
    <PersonMessage
      message={message}
      names={names}
      reactions={reactions}
      onEdit={message.authorId === me ? onEdit : undefined}
      onInterrupt={onInterrupt}
    >
      {children}
    </PersonMessage>
  );
}

/**
 * A person's bubble. A tap on their own shows its actions (Edit), which turns it into a text box in
 * place; long presses stay free for selecting text. An edited one says so, with the time a tap away.
 */
function PersonMessage({
  message,
  names,
  reactions,
  onEdit,
  onInterrupt,
  children,
}: {
  message: Message;
  names: Names;
  reactions?: Reaction[];
  onEdit?: (body: string) => void;
  onInterrupt?: () => Promise<unknown>;
  children?: ReactNode;
}) {
  const t = useT();
  const colors = useColors();
  const theme = useTheme();
  const styles = useStyles();
  const relativeTime = useRelativeTime();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const mine = !!onEdit;
  // A message with files may lose its text; one without keeps at least a word.
  const canSave = draft !== null && (draft.trim().length > 0 || !!message.attachments?.length);
  const save = () => {
    if (!canSave) return;
    if (draft.trim() !== message.body) onEdit?.(draft.trim());
    setDraft(null);
    setOpen(false);
  };
  const actions = mine || !!message.editedAt;

  return (
    <View style={styles.user}>
      {!mine && <Text style={styles.author}>{names[message.authorId] ?? t("common.member")}</Text>}
      {draft !== null ? (
        <View style={[styles.bubble, styles.editing]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            multiline
            autoFocus
            keyboardAppearance={theme}
            accessibilityLabel={t("message.edit")}
            style={[styles.bubbleText, styles.editInput]}
          />
          <View style={styles.editActions}>
            <Pressable accessibilityRole="button" onPress={() => setDraft(null)} style={styles.editButton}>
              <Text style={{ color: colors.muted, fontSize: 14 }}>{t("common.cancel")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={!canSave}
              onPress={save}
              style={[styles.editButton, styles.saveButton, !canSave && { opacity: 0.5 }]}
            >
              <Text style={{ color: colors.ground, fontSize: 14, fontWeight: "600" }}>{t("message.editSave")}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        !!message.body && (
          <Pressable
            disabled={!actions}
            onPress={() => setOpen((o) => !o)}
            accessibilityHint={mine ? t("message.edit") : undefined}
            style={styles.bubble}
          >
            <Collapsible height={BUBBLE_LINE * 10} long={surelyLong(message.body, 10)}>
              <Text selectable style={styles.bubbleText}>
                {message.body}
              </Text>
            </Collapsible>
          </Pressable>
        )
      )}
      <Attachments projectId={message.projectId} attachments={message.attachments} />
      {draft === null && (open || message.editedAt) && (
        <View style={styles.meta}>
          {message.editedAt && (
            <Text style={styles.time}>
              {open ? t("message.editedAt", { time: relativeTime(message.editedAt) }) : t("message.edited")}
            </Text>
          )}
          {open && mine && (
            <Pressable
              accessibilityRole="button"
              onPress={() => setDraft(message.body)}
              style={({ pressed }) => [styles.editLink, pressed && { backgroundColor: colors.hover }]}
            >
              <Pencil size={13} color={colors.muted} />
              <Text style={{ color: colors.muted, fontSize: 13 }}>{t("message.edit")}</Text>
            </Pressable>
          )}
        </View>
      )}
      {onInterrupt && draft === null && <QueuedLine onInterrupt={onInterrupt} />}
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
  return (
    <Collapsible height={MARKDOWN_LINE * 24} long={surelyLong(body, 24)}>
      {children}
    </Collapsible>
  );
}

/** Files on a message, as chips that open the file's preview, like the web's. */
function Attachments({ projectId, attachments }: { projectId: string; attachments?: Attachment[] }) {
  const { t, locale } = useI18n();
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  if (!attachments?.length) return null;
  return (
    <View style={styles.attachments}>
      {attachments.map((a) => {
        const Icon = fileKind(a.contentType, a.path) === "image" ? FileImage : Paperclip;
        return (
          <Pressable
            key={a.path}
            accessibilityRole="button"
            accessibilityHint={t("mobile.openAttachment")}
            onPress={() => router.push(`/projects/${projectId}/file?path=${encodeURIComponent(a.path)}` as Href)}
            style={({ pressed }) => [styles.attachment, pressed && { backgroundColor: colors.hover }]}
          >
            <Icon size={13} color={colors.subtle} />
            <Text style={styles.attachmentName} numberOfLines={1}>
              {a.name}
            </Text>
            <Text style={styles.attachmentSize}>{formatBytes(a.size, locale)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Reactions({ reactions }: { reactions?: Reaction[] }) {
  const colors = useColors();
  const styles = useStyles();
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

/** The working line. `cli`: the CLI doing a thread's work, shown instead of Myrel's mark. */
export function Thinking({ label, cli, onStop }: { label: string; cli?: string | null; onStop?: () => Promise<unknown> }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.agent}>
      <CliMark cli={cli} tile />
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 4 }} accessibilityRole="progressbar" accessibilityLabel={label}>
        <Spinner size={15} color={colors.subtle} />
        <Text style={{ color: colors.subtle, fontSize: 15, flexShrink: 1 }} numberOfLines={2}>
          {label}…
        </Text>
      </View>
      {onStop && <StopButton onStop={onStop} />}
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
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
    editing: { width: "85%", borderColor: colors.accentLine, gap: 8 },
    editInput: { padding: 0, minHeight: BUBBLE_LINE * 2, maxHeight: BUBBLE_LINE * 10, textAlignVertical: "top" },
    editActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
    editButton: { borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 6 },
    saveButton: { backgroundColor: colors.accent },
    editLink: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 2 },
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
      maxWidth: 260,
    },
    attachmentName: { color: colors.body, fontSize: 13, flexShrink: 1 },
    attachmentSize: { color: colors.subtle, fontSize: 12 },
    reaction: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.edge,
      backgroundColor: colors.raised,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
  }),
);
