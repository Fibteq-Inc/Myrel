import type { Message, Reaction } from "@altair/protocol";
import { type ReactNode, useMemo } from "react";
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { decisionAnswers } from "../lib/decision";
import { useOpenLink } from "../lib/links";
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
  working,
  placeholder,
  onSend,
  header,
  footerFor,
  empty,
}: {
  messages: Message[];
  me: string;
  names: Names;
  reactions: Record<string, Reaction[]>;
  working: boolean;
  placeholder: string;
  onSend: (body: string) => void;
  /** Pinned above the list (e.g. a thread's checklist). */
  header?: ReactNode;
  /** Rendered under a message, e.g. the card of the thread it opened. */
  footerFor?: (message: Message) => ReactNode;
  empty?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const openLink = useOpenLink();
  const answers = useMemo(() => decisionAnswers(messages), [messages]);
  // Inverted list: index 0 sits at the bottom, so the newest message comes first.
  const data = useMemo(() => [...messages].reverse(), [messages]);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={0}>
      {header}
      <FlatList
        inverted
        data={data}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={working ? <Thinking label="Working" /> : undefined}
        ListEmptyComponent={empty ? <View style={styles.empty}>{empty}</View> : undefined}
        renderItem={({ item }) => (
          <MessageView
            message={item}
            me={me}
            names={names}
            reactions={reactions[item.id]}
            onLink={openLink}
            decision={
              item.authorKind === "agent" ? { answer: answers.get(item.id), onChoose: onSend } : undefined
            }
          >
            {footerFor?.(item)}
          </MessageView>
        )}
      />
      <View style={{ paddingBottom: Platform.OS === "ios" ? insets.bottom : insets.bottom + 4 }}>
        <Composer placeholder={placeholder} onSend={onSend} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 16, paddingVertical: 16, gap: 22, flexGrow: 1 },
  // Inverted lists flip their children; flip the empty state back.
  empty: { flex: 1, alignItems: "center", justifyContent: "center", transform: [{ scaleY: -1 }] },
});
