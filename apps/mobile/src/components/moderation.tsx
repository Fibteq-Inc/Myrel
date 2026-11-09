import { useT } from "@myrel/i18n/react";
import { MAX_REPORT_NOTE, type Message, ReportReason, type ReportTarget } from "@myrel/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { Ban, CircleCheck, Copy, Flag, TextSelect } from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSession } from "../lib/session";
import { makeStyles, radius, useColors } from "../theme";
import { Option, Sheet } from "./cli-picker";
import type { Names } from "./message";
import { Button, errorMessage, Input } from "./ui";

/**
 * Reporting content and blocking members (App Store Guideline 1.2), as on the web: a long press on a
 * message opens its actions (copy, select text, report, block its author), an artifact has a Report
 * button, and the members list blocks and unblocks.
 */

/** Blocks and unblocks a member for the signed-in person, refreshing the member list their messages are hidden by. */
export function useBlockMember(projectId: string) {
  const t = useT();
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["projects", server, projectId, "members"] });
  const block = useMutation({ mutationFn: (userId: string) => api.blockMember(projectId, userId), onSettled: refresh });
  const unblock = useMutation({ mutationFn: (userId: string) => api.unblockMember(projectId, userId), onSettled: refresh });
  const failed = (err: unknown) => Alert.alert(t("common.error"), errorMessage(err, t("common.error")));
  return {
    /** Asks first; `then` runs once the person confirmed. */
    confirmBlock(userId: string, name: string, then?: () => void) {
      Alert.alert(t("block.confirmTitle", { name }), t("block.confirmBody", { name }), [
        { text: t("mobile.cancel"), style: "cancel" },
        {
          text: t("block.confirm"),
          style: "destructive",
          onPress: () => {
            block.mutate(userId, { onError: failed });
            then?.();
          },
        },
      ]);
    },
    unblock: (userId: string) => unblock.mutate(userId, { onError: failed }),
    pending: block.isPending || unblock.isPending,
  };
}

type Mode = "actions" | "select" | "report" | "sent";

/**
 * What a long press on a message opens. One sheet that changes its content, since iOS cannot show
 * a second modal while the first is still closing.
 */
export function MessageSheet({
  message,
  me,
  names,
  onClose,
}: {
  message: Message;
  me: string;
  names: Names;
  onClose: () => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<Mode>("actions");
  const { confirmBlock } = useBlockMember(message.projectId);
  const theirs = message.authorId !== me && message.authorKind !== "system";
  const name = names[message.authorId];
  const titles: Record<Mode, string> = {
    actions: t("message.actions"),
    select: t("message.selectText"),
    report: t("report.title"),
    sent: t("report.sent"),
  };

  return (
    <Sheet open onClose={onClose} title={titles[mode]}>
      {mode === "actions" && (
        <>
          {!!message.body && (
            <Action
              icon={Copy}
              title={t("common.copy")}
              onPress={() => {
                void Clipboard.setStringAsync(message.body);
                onClose();
              }}
            />
          )}
          {!!message.body && <Action icon={TextSelect} title={t("message.selectText")} onPress={() => setMode("select")} />}
          {theirs && <Action icon={Flag} title={t("report.message")} onPress={() => setMode("report")} />}
          {theirs && message.authorKind === "user" && name && (
            <Action icon={Ban} title={t("block.action", { name })} danger onPress={() => confirmBlock(message.authorId, name, onClose)} />
          )}
        </>
      )}
      {mode === "select" && <SelectableText text={message.body} />}
      {mode === "report" && (
        <ReportForm projectId={message.projectId} target={{ kind: "message", messageId: message.id }} onSent={() => setMode("sent")} />
      )}
      {mode === "sent" && <Sent />}
    </Sheet>
  );
}

/** The Report sheet for an artifact. */
export function ReportSheet({ projectId, target, onClose }: { projectId: string; target: ReportTarget; onClose: () => void }) {
  const t = useT();
  const [sent, setSent] = useState(false);
  return (
    <Sheet open onClose={onClose} title={sent ? t("report.sent") : t("report.title")}>
      {sent ? <Sent /> : <ReportForm projectId={projectId} target={target} onSent={() => setSent(true)} />}
    </Sheet>
  );
}

/** A reason, an optional note and Send. Scrolls when the keyboard leaves too little room. */
function ReportForm({ projectId, target, onSent }: { projectId: string; target: ReportTarget; onSent: () => void }) {
  const t = useT();
  const styles = useStyles();
  const { api } = useSession();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState("");
  const send = useMutation({
    mutationFn: () => api.report(projectId, { target, reason: reason!, ...(note.trim() && { note: note.trim() }) }),
    onSuccess: onSent,
  });
  return (
    <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ gap: 2 }} keyboardShouldPersistTaps="handled">
      <Text style={[styles.hint, { marginBottom: 6 }]}>{t("report.body")}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={t("report.reason")}>
        {ReportReason.options.map((r) => (
          <Option key={r} kind="radio" checked={reason === r} title={t(`report.reason.${r}`)} onPress={() => setReason(r)} />
        ))}
      </View>
      <Input
        value={note}
        onChangeText={setNote}
        placeholder={t("report.note")}
        accessibilityLabel={t("report.note")}
        multiline
        maxLength={MAX_REPORT_NOTE}
        autoCapitalize="sentences"
        autoCorrect
        style={styles.note}
      />
      {send.error && (
        <Text style={styles.error}>
          {t("report.failed")}: {errorMessage(send.error, t("common.error"))}
        </Text>
      )}
      <Button onPress={() => send.mutate()} disabled={!reason} pending={send.isPending} style={{ marginTop: 8 }}>
        {t("report.send")}
      </Button>
    </ScrollView>
  );
}

function Sent() {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.sent} accessibilityLiveRegion="polite">
      <CircleCheck size={20} color={colors.ok} />
      <Text style={[styles.hint, { flex: 1, fontSize: 14, lineHeight: 20 }]}>{t("report.sentBody")}</Text>
    </View>
  );
}

/** The whole message as selectable text, since a long press on the message itself opens this sheet. */
function SelectableText({ text }: { text: string }) {
  const styles = useStyles();
  return (
    <ScrollView style={{ flexShrink: 1, maxHeight: 420 }}>
      <Text selectable style={styles.selectable}>
        {text}
      </Text>
    </ScrollView>
  );
}

function Action({
  icon: Icon,
  title,
  danger,
  onPress,
}: {
  icon: typeof Copy;
  title: string;
  danger?: boolean;
  onPress: () => void;
}): ReactNode {
  const colors = useColors();
  const styles = useStyles();
  const color = danger ? colors.bad : colors.body;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && { backgroundColor: colors.hover }]}
    >
      <Icon size={18} color={danger ? colors.bad : colors.muted} />
      <Text style={[styles.actionText, { color }]}>{title}</Text>
    </Pressable>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    hint: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    note: { minHeight: 64, marginTop: 8, paddingTop: 10, textAlignVertical: "top" },
    error: { color: colors.bad, fontSize: 13, marginTop: 6 },
    sent: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 4 },
    selectable: { color: colors.fg, fontSize: 15, lineHeight: 22 },
    action: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 12 },
    actionText: { flex: 1, fontSize: 15 },
  }),
);
