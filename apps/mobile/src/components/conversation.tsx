import { useT } from "@myrel/i18n/react";
import { type Artifact, decisionPicks, type Message, parsePlanUpdate, planChecklist, type Reaction } from "@myrel/protocol";
import { ArrowDown } from "lucide-react-native";
import { type ComponentRef, type ReactNode, type Ref, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { decisionAnswers } from "../lib/decision";
import { useOpenArtifact, useOpenLink } from "../lib/links";
import { makeStyles, useColors } from "../theme";
import { ChatSkeleton } from "./chat-skeleton";
import { PlanCard, PlanUpdateNote } from "./checklist";
import { Composer, type ComposerHandle } from "./composer";
import { MessageView, type Names, Thinking } from "./message";

/**
 * A chat column: messages newest at the bottom, a thinking line while the
 * agent works, and the composer. Decision cards in agent messages are
 * answered with one tap, which sends the option as the person's reply.
 */
export function Conversation({
  messages,
  loading = false,
  hasEarlier = false,
  onLoadEarlier,
  me,
  names,
  reactions,
  artifacts,
  projectId,
  threadId,
  working,
  placeholder,
  onSend,
  onEdit,
  onInterrupt,
  onStop,
  header,
  plan,
  onOpenPlan,
  footerFor,
  empty,
  tools,
  composer,
}: {
  messages: Message[];
  /** The first sync is still running: a placeholder instead of messages, so the list opens at its newest one. */
  loading?: boolean;
  /** Older messages are still on the server: scrolling up to the oldest held fetches the page before it. */
  hasEarlier?: boolean;
  onLoadEarlier?: () => Promise<void>;
  me: string;
  names: Names;
  reactions: Record<string, Reaction[]>;
  artifacts: Record<string, Artifact>;
  projectId: string;
  /** The thread this is, for file links that point into its worktree. */
  threadId?: string;
  /** Null when idle; otherwise what to show while the agent works. */
  working: string | null;
  placeholder: string;
  /** `attachments` are paths of files the composer uploaded. */
  onSend: (body: string, attachments?: string[]) => void;
  /** Changes the text of a message the person sent. */
  onEdit?: (messageId: string, body: string) => void;
  /** Set when a message waits for the thread's working agent: stops its turn so the message goes now. */
  onInterrupt?: { messageId: string; run: () => Promise<unknown> };
  /** Set in a thread: stops its agent's turn from the "Working" line. */
  onStop?: () => Promise<unknown>;
  /** Pinned above the list (e.g. a thread's checklist). */
  header?: ReactNode;
  /** The plan card the agent is moving along, drawn from the thread's fresh checklist. */
  plan?: { messageId: string; text: string; live: boolean };
  /** Opens the whole plan above the conversation, from a plan update note. */
  onOpenPlan?: () => void;
  /** Rendered under a message, e.g. the card of the thread it opened. */
  footerFor?: (message: Message) => ReactNode;
  empty?: ReactNode;
  /** Controls in the composer, e.g. the CLI picker. */
  tools?: ReactNode;
  /** Puts text in the composer from outside, e.g. a picked example task. */
  composer?: Ref<ComposerHandle>;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const openLink = useOpenLink(projectId, threadId);
  const openArtifact = useOpenArtifact(projectId);
  const answers = useMemo(() => decisionAnswers(messages), [messages]);
  // A tap on a card is shown on the card itself, not again as a bubble.
  const picks = useMemo(() => decisionPicks(messages), [messages]);
  // Inverted list: index 0 sits at the bottom, so the newest message comes first.
  const data = useMemo(() => (loading ? [] : [...messages].reverse()), [loading, messages]);
  const list = useRef<FlatList<Message>>(null);
  // A message the person just sent brings them to the newest one even when they had scrolled up.
  const newest = data[0];
  const seen = useRef(newest?.id);
  useEffect(() => {
    const sent = newest && newest.id !== seen.current && newest.authorKind === "user" && newest.authorId === me;
    seen.current = newest?.id;
    if (sent) list.current?.scrollToOffset({ offset: 0, animated: true });
  }, [newest, me]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadEarlier = () => {
    if (loading || !hasEarlier || loadingEarlier || !onLoadEarlier) return;
    setLoadingEarlier(true);
    onLoadEarlier()
      .catch(() => {})
      .finally(() => setLoadingEarlier(false));
  };
  // Far from the newest message, a button takes the reader back down in one tap.
  const [away, setAway] = useState(false);
  // KeyboardAvoidingView measures itself relative to its parent, so anything
  // above it (the navigation header, the project tabs) would leave the
  // composer under the keyboard. Its distance from the top of the window
  // is the offset that makes up for that.
  const frame = useRef<ComponentRef<typeof View>>(null);
  const [top, setTop] = useState(0);
  // The keyboard covers the home indicator and navigation bar, so their inset
  // would only add a gap between the composer and the keyboard.
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", () => setKeyboardOpen(true));
    const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboardOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return (
    <View
      ref={frame}
      style={{ flex: 1 }}
      onLayout={() => frame.current?.measureInWindow((_x, y) => setTop(y))}
    >
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={top}>
        {header}
        <View style={{ flex: 1 }}>
          <FlatList
            ref={list}
            inverted
            data={data}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.list}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            // A new message keeps what the reader is looking at in place, and follows only near the newest one.
            maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: FOLLOW }}
            // Inverted: the offset is the distance from the newest message.
            onScroll={(e) => setAway(e.nativeEvent.contentOffset.y > AWAY)}
            scrollEventThrottle={100}
            ListHeaderComponent={working ? <Thinking label={working} onStop={onStop} /> : undefined}
            // Inverted: the end of the list is its top, the oldest message held.
            onEndReached={loadEarlier}
            onEndReachedThreshold={0.5}
            ListFooterComponent={
              hasEarlier && !loading ? (
                <View style={styles.earlier}>
                  <ActivityIndicator color={colors.subtle} />
                </View>
              ) : undefined
            }
            ListEmptyComponent={
              loading ? (
                <View style={styles.loading}>
                  <ChatSkeleton />
                </View>
              ) : empty ? (
                <View style={styles.empty}>{empty}</View>
              ) : undefined
            }
            renderItem={({ item }) => {
              const footer = footerFor?.(item);
              // A pick that opened a thread keeps its bubble, which carries the thread's card.
              if (picks.has(item.id) && !footer) return null;
              const checklist = item.authorKind === "agent" ? planChecklist(item.body) : null;
              if (checklist !== null) {
                const current = plan && item.id === plan.messageId ? plan : null;
                return <PlanCard text={current?.text ?? checklist} live={current?.live ?? false} />;
              }
              const update = item.authorKind === "agent" ? parsePlanUpdate(item.body) : null;
              if (update) return <PlanUpdateNote update={update} onOpenPlan={onOpenPlan} />;
              return (
                <MessageView
                  message={item}
                  me={me}
                  names={names}
                  reactions={reactions[item.id]}
                  artifacts={artifacts}
                  onLink={openLink}
                  onOpenArtifact={openArtifact}
                  onEdit={onEdit && ((body) => onEdit(item.id, body))}
                  onInterrupt={item.id === onInterrupt?.messageId ? onInterrupt.run : undefined}
                  decision={
                    item.authorKind === "agent" ? { answer: answers.get(item.id), onChoose: onSend } : undefined
                  }
                >
                  {footer}
                </MessageView>
              );
            }}
          />
          {away && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("chat.toEnd")}
              onPress={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
              style={({ pressed }) => [styles.toEnd, pressed && { backgroundColor: colors.hover }]}
            >
              <ArrowDown size={18} color={colors.muted} />
            </Pressable>
          )}
        </View>
        <View style={{ paddingBottom: keyboardOpen ? 8 : Platform.OS === "ios" ? insets.bottom : insets.bottom + 4 }}>
          <Composer placeholder={placeholder} onSend={onSend} tools={tools} handle={composer} />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

/** How far from the newest message (in px) the reader has to be before the "jump to latest" button shows. */
const AWAY = 400;

/** Within this distance (in px) of the newest message, the list keeps following new ones. */
const FOLLOW = 80;

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    list: { paddingHorizontal: 16, paddingVertical: 16, gap: 22, flexGrow: 1 },
    // Inverted lists flip their children; flip the empty state back.
    toEnd: {
      position: "absolute",
      bottom: 12,
      alignSelf: "center",
      width: 38,
      height: 38,
      borderRadius: 19,
      borderWidth: 1,
      borderColor: colors.edge,
      backgroundColor: colors.raised,
      alignItems: "center",
      justifyContent: "center",
    },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", transform: [{ scaleY: -1 }] },
    // Flipped back like the empty state; the placeholder sits where the newest messages will.
    loading: { flex: 1, justifyContent: "flex-end", overflow: "hidden", transform: [{ scaleY: -1 }] },
    earlier: { alignItems: "center", paddingVertical: 8 },
  }),
);
