import { type Artifact, decisionPicks, type Message, parsePlanUpdate, planChecklist, type Reaction } from "@myrel/protocol";
import { type ComponentRef, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Keyboard, KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { decisionAnswers } from "../lib/decision";
import { useOpenArtifact, useOpenLink } from "../lib/links";
import { PlanCard, PlanUpdateNote } from "./checklist";
import { Composer } from "./composer";
import { MessageView, type Names, Thinking } from "./message";

/**
 * A chat column: messages newest at the bottom, a thinking line while the
 * agent works, and the composer. Decision cards in agent messages are
 * answered with one tap, which sends the option as the person's reply.
 */
export function Conversation({
  messages,
  me,
  names,
  reactions,
  artifacts,
  projectId,
  threadId,
  working,
  placeholder,
  onSend,
  header,
  plan,
  onOpenPlan,
  footerFor,
  empty,
}: {
  messages: Message[];
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
  onSend: (body: string) => void;
  /** Pinned above the list (e.g. a thread's checklist). */
  header?: ReactNode;
  /** The plan card the agent is moving along, drawn from the thread's fresh checklist. */
  plan?: { messageId: string; text: string; live: boolean };
  /** Opens the whole plan above the conversation, from a plan update note. */
  onOpenPlan?: () => void;
  /** Rendered under a message, e.g. the card of the thread it opened. */
  footerFor?: (message: Message) => ReactNode;
  empty?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const openLink = useOpenLink(projectId, threadId);
  const openArtifact = useOpenArtifact(projectId);
  const answers = useMemo(() => decisionAnswers(messages), [messages]);
  // A tap on a card is shown on the card itself, not again as a bubble.
  const picks = useMemo(() => decisionPicks(messages), [messages]);
  // Inverted list: index 0 sits at the bottom, so the newest message comes first.
  const data = useMemo(() => [...messages].reverse(), [messages]);
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
        <FlatList
          inverted
          data={data}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.list}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={working ? <Thinking label={working} /> : undefined}
          ListEmptyComponent={empty ? <View style={styles.empty}>{empty}</View> : undefined}
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
                decision={
                  item.authorKind === "agent" ? { answer: answers.get(item.id), onChoose: onSend } : undefined
                }
              >
                {footer}
              </MessageView>
            );
          }}
        />
        <View style={{ paddingBottom: keyboardOpen ? 8 : Platform.OS === "ios" ? insets.bottom : insets.bottom + 4 }}>
          <Composer placeholder={placeholder} onSend={onSend} />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 16, paddingVertical: 16, gap: 22, flexGrow: 1 },
  // Inverted lists flip their children; flip the empty state back.
  empty: { flex: 1, alignItems: "center", justifyContent: "center", transform: [{ scaleY: -1 }] },
});
