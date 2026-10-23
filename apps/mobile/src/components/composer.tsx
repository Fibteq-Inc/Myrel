import { useT } from "@myrel/i18n/react";
import type { ProjectFile } from "@myrel/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, CircleAlert, Paperclip, X } from "lucide-react-native";
import { useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { pickPhotos } from "../lib/pick-photos";
import { platform } from "../lib/platform";
import { useProject } from "../lib/project";
import { filesQueryKey } from "../lib/queries";
import { useSession } from "../lib/session";
import { makeStyles, radius, useColors, useTheme } from "../theme";
import { errorMessage, Spinner } from "./ui";

type Pending = { id: number; name: string; file?: ProjectFile; error?: string };
type Picked = { name: string; blob: Blob };

/**
 * Message box pinned to the bottom of a conversation. The paperclip attaches photos or files:
 * they upload right away and are sent by path, like the web's composer.
 */
export function Composer({
  placeholder,
  onSend,
  disabled,
}: {
  placeholder: string;
  /** `attachments` are paths of files already uploaded to the project. */
  onSend: (body: string, attachments: string[]) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const theme = useTheme();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const nextId = useRef(0);
  const uploading = pending.some((p) => !p.file && !p.error);
  const ready = pending.flatMap((p) => (p.file ? [p.file.path] : []));
  const canSend = (body.trim().length > 0 || ready.length > 0) && !uploading && !disabled;

  function attach(files: Picked[]) {
    for (const f of files) {
      const id = nextId.current++;
      setPending((list) => [...list, { id, name: f.name }]);
      api.upload(projectId, f.name, f.blob).then(
        (file) => {
          setPending((list) => list.map((p) => (p.id === id ? { ...p, file } : p)));
          void queryClient.invalidateQueries({ queryKey: filesQueryKey(server, projectId) });
        },
        (err) => setPending((list) => list.map((p) => (p.id === id ? { ...p, error: errorMessage(err, t("common.error")) } : p))),
      );
    }
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
          value={body}
          onChangeText={setBody}
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
    pending: { gap: 6, paddingHorizontal: 6 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      maxWidth: 220,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.edge,
      backgroundColor: colors.ground,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    chipName: { color: colors.body, fontSize: 13, flexShrink: 1 },
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
