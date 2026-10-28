import { draftKey } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import { MAX_MESSAGE_LENGTH, type ProjectFile, takeLongPaste } from "@myrel/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, CircleAlert, Paperclip, X } from "lucide-react-native";
import { type ComponentRef, type ReactNode, type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useDraft } from "../lib/drafts";
import { pickPhotos } from "../lib/pick-photos";
import { platform } from "../lib/platform";
import { useProject } from "../lib/project";
import { filesQueryKey } from "../lib/queries";
import { useSession } from "../lib/session";
import { makeStyles, radius, useColors, useTheme } from "../theme";
import { errorMessage, Spinner } from "./ui";

/** `text` is set for a long paste that was turned into a file, so it can go back into the message. */
type Pending = { id: number; name: string; file?: ProjectFile; error?: string; text?: string };

/** Lets a parent put text in the box, e.g. an example task picked from an empty chat. */
export type ComposerHandle = {
  /** Replaces the text with `text`, focuses the field and selects `select` (start, end). */
  fill: (text: string, select?: [number, number]) => void;
};
type Picked = { name: string; blob: Blob };

/**
 * Message box pinned to the bottom of a conversation. The paperclip attaches photos or files:
 * they upload right away and are sent by path, like the web's composer. A long text paste is
 * attached the same way as a .txt file, with a way to put it back into the message. Unsent
 * text is kept on this device per project chat and thread, and comes back when it opens again.
 */
export function Composer({
  placeholder,
  onSend,
  disabled,
  tools,
  handle,
  threadId,
}: {
  placeholder: string;
  /** Shown above the text field, e.g. the CLI picker. */
  tools?: ReactNode;
  /** `attachments` are paths of files already uploaded to the project. */
  onSend: (body: string, attachments: string[]) => void;
  disabled?: boolean;
  handle?: Ref<ComposerHandle>;
  /** The thread this composer writes to; none in the project chat. Its draft is kept apart. */
  threadId?: string;
}) {
  const t = useT();
  const theme = useTheme();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const [body, setBody] = useDraft(draftKey(projectId, threadId));
  const [pending, setPending] = useState<Pending[]>([]);
  const nextId = useRef(0);
  const uploading = pending.some((p) => !p.file && !p.error);
  const ready = pending.flatMap((p) => (p.file ? [p.file.path] : []));
  const canSend = (body.trim().length > 0 || ready.length > 0) && !uploading && !disabled;
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  // The selection waits for the new text to reach the field.
  const selection = useRef<[number, number] | null>(null);
  useImperativeHandle(handle, () => ({
    fill(text, select) {
      selection.current = select ?? [text.length, text.length];
      setBody(text);
    },
  }));
  useEffect(() => {
    if (!selection.current) return;
    const [start, end] = selection.current;
    selection.current = null;
    input.current?.focus();
    input.current?.setSelection(start, end);
  }, [body]);

  function attach(files: Picked[], text?: string) {
    for (const f of files) {
      const id = nextId.current++;
      setPending((list) => [...list, { id, name: f.name, text }]);
      api.upload(projectId, f.name, f.blob).then(
        (file) => {
          setPending((list) => list.map((p) => (p.id === id ? { ...p, file } : p)));
          void queryClient.invalidateQueries({ queryKey: filesQueryKey(server, projectId) });
        },
        (err) => setPending((list) => list.map((p) => (p.id === id ? { ...p, error: errorMessage(err, t("common.error")) } : p))),
      );
    }
  }

  // React Native has no paste event: a long paste shows up as one big change of the text.
  function onChangeText(next: string) {
    const paste = takeLongPaste(body, next);
    if (!paste) return setBody(next);
    setBody(paste.rest);
    const time = new Date().toTimeString().slice(0, 8).replaceAll(":", "-");
    const name = t("composer.pastedFileName", { time });
    attach([{ name, blob: new Blob([paste.pasted], { type: "text/plain" }) }], paste.pasted);
  }

  /** Puts a pasted file's text back into the message (the uploaded copy stays in the project files). */
  function inline(item: Pending) {
    setPending((list) => list.filter((p) => p.id !== item.id));
    setBody((b) => (b ? `${b}\n${item.text}` : item.text!));
  }

  function pick(from: "photos" | "files") {
    const picking = from === "photos" ? pickPhotos() : platform.pickFiles({ multiple: true });
    picking.then(attach, (err) => Alert.alert(t("common.error"), errorMessage(err, "")));
  }

  function chooseSource() {
    Alert.alert(t("composer.attach"), undefined, [
      { text: t("mobile.attachPhotos"), onPress: () => pick("photos") },
      { text: t("mobile.attachFiles"), onPress: () => pick("files") },
      { text: t("common.cancel"), style: "cancel" },
    ]);
  }

  function send() {
    if (!canSend) return;
    onSend(body.trim(), ready);
    setBody("");
    setPending([]);
  }

  return (
    <View style={styles.box}>
      {pending.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pending}>
          {pending.map((p) => (
            <View key={p.id} style={[styles.chip, p.error && { borderColor: colors.bad }]}>
              {p.error ? (
                <CircleAlert size={13} color={colors.bad} />
              ) : p.file ? (
                <Paperclip size={13} color={colors.subtle} />
              ) : (
                <Spinner size={13} color={colors.subtle} />
              )}
              <Text style={styles.chipName} numberOfLines={1}>
                {p.error ?? p.name}
              </Text>
              {p.text !== undefined && body.length + p.text.length <= MAX_MESSAGE_LENGTH && (
                <Pressable accessibilityRole="button" hitSlop={8} onPress={() => inline(p)}>
                  <Text style={styles.chipAction}>{t("composer.insertAsText")}</Text>
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("files.remove", { name: p.name })}
                hitSlop={8}
                onPress={() => setPending((list) => list.filter((x) => x.id !== p.id))}
              >
                <X size={14} color={colors.subtle} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
      {tools && <View style={styles.tools}>{tools}</View>}
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("composer.attach")}
          disabled={disabled}
          onPress={chooseSource}
          style={styles.attach}
        >
          <Paperclip size={20} color={colors.muted} />
        </Pressable>
        <TextInput
          ref={input}
          value={body}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.subtle}
          keyboardAppearance={theme}
          multiline
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
          <ArrowUp size={20} color="#ffffff" />
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    box: {
      gap: 6,
      marginHorizontal: 12,
      marginBottom: 8,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: colors.edge,
      backgroundColor: colors.raised,
      paddingLeft: 6,
      paddingRight: 8,
      paddingVertical: 8,
    },
    row: { flexDirection: "row", alignItems: "flex-end", gap: 4 },
    // Pickers sit side by side and wrap only when the screen is too narrow for them.
    tools: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
    pending: { gap: 6, paddingHorizontal: 6 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      maxWidth: 300,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.edge,
      backgroundColor: colors.ground,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    chipName: { color: colors.body, fontSize: 13, flexShrink: 1 },
    chipAction: { color: colors.accent, fontSize: 12, fontWeight: "600" },
    attach: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
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
