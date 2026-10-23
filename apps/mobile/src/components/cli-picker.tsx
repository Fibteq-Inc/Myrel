import { useT } from "@myrel/i18n/react";
import { CLI_NAMES, type CliId, type RunnerCli, type Thread } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Sparkles, SquareTerminal } from "lucide-react-native";
import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { runnersQueryKey, workspaceQueryKey } from "../lib/queries";
import { useSession } from "../lib/session";
import { colors, radius } from "../theme";

export type Pickable = { clis: RunnerCli[]; folderCli: CliId };

export function cliName(id: string): string {
  return CLI_NAMES[id as CliId] ?? id;
}

/**
 * The CLIs the signed-in person can pick for this project's threads, as on the web: those on the
 * project folder's computer when it is theirs and the project does not always work in the cloud.
 * Null when there is nothing to pick.
 */
export function usePickableClis(projectId: string): Pickable | null {
  const { api, server } = useSession();
  const { data: workspace } = useQuery({ queryKey: workspaceQueryKey(server, projectId), queryFn: () => api.getWorkspace(projectId) });
  const { data: runners } = useQuery({ queryKey: runnersQueryKey(server), queryFn: () => api.listRunners(), enabled: !!workspace });
  const { data: settings } = useQuery({
    queryKey: ["project-settings", server, projectId],
    queryFn: () => api.getProjectSettings(projectId),
    enabled: !!workspace,
  });
  // Only your own computers are listed, so finding it means it is yours.
  const runner = workspace && runners?.find((r) => r.id === workspace.runnerId);
  if (!workspace || !runner || runner.clis.length === 0 || settings?.taskTarget === "cloud") return null;
  return { clis: runner.clis, folderCli: workspace.cli };
}

/** Project chat: the CLIs a new ask's thread may run with. None: the folder's. Several: Myrel picks. */
export function AskCliPicker({ pickable, value, onChange }: { pickable: Pickable; value: CliId[]; onChange: (next: CliId[]) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const label =
    value.length === 0 ? cliName(pickable.folderCli) : value.length === 1 ? cliName(value[0]!) : t("cliPicker.several", { count: value.length });
  const toggle = (id: CliId) => onChange(value.includes(id) ? value.filter((c) => c !== id) : [...value, id]);
  return (
    <>
      <Chip label={label} active={value.length > 0} several={value.length > 1} title={t("cliPicker.askTitle")} onPress={() => setOpen(true)} />
      <Sheet open={open} onClose={() => setOpen(false)} title={t("cliPicker.askTitle")} hint={pickable.clis.length > 1 ? t("cliPicker.askHint") : undefined}>
        <Option kind="radio" checked={value.length === 0} title={t("cliPicker.default", { cli: cliName(pickable.folderCli) })} onPress={() => onChange([])} />
        {pickable.clis.map((c) => (
          <Option key={c.id} kind="check" checked={value.includes(c.id)} title={cliName(c.id)} note={limitNote(c, t)} onPress={() => toggle(c.id)} />
        ))}
      </Sheet>
    </>
  );
}

/** Thread: the CLI it runs with from its next turn. */
export function ThreadCliPicker({ pickable, thread, onChange }: { pickable: Pickable; thread: Thread; onChange: (cli: CliId | null) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const current = thread.cli?.id;
  const pick = (cli: CliId | null) => {
    if ((cli ?? undefined) !== current) onChange(cli);
    setOpen(false);
  };
  return (
    <>
      <Chip
        label={cliName(current ?? pickable.folderCli)}
        active={!!current}
        several={thread.cli?.by === "coordinator"}
        title={t("cliPicker.threadTitle")}
        onPress={() => setOpen(true)}
      />
      <Sheet open={open} onClose={() => setOpen(false)} title={t("cliPicker.threadTitle")} hint={t("cliPicker.threadHint")}>
        <Option kind="radio" checked={!current} title={t("cliPicker.default", { cli: cliName(pickable.folderCli) })} onPress={() => pick(null)} />
        {pickable.clis.map((c) => (
          <Option key={c.id} kind="radio" checked={current === c.id} title={cliName(c.id)} note={limitNote(c, t)} onPress={() => pick(c.id)} />
        ))}
      </Sheet>
    </>
  );
}

/** The note at the top of a thread whose CLI Myrel picked among the ones the person offered. */
export function ThreadCliNote({ thread }: { thread: Thread }) {
  const t = useT();
  const cli = thread.cli;
  if (!cli || cli.by !== "coordinator") return null;
  return (
    <View style={styles.note}>
      <Sparkles size={15} color={colors.accent} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.noteText}>{t("cliPicker.picked", { cli: cliName(cli.id), options: cli.options.map(cliName).join(", ") })}</Text>
        {cli.reason && <Text style={styles.noteReason}>{cli.reason}</Text>}
      </View>
    </View>
  );
}

/** Under a person's ask in the project chat: the CLIs they offered for it. */
export function OfferedClis({ clis }: { clis: string[] }) {
  const t = useT();
  return (
    <View style={styles.offered}>
      <SquareTerminal size={13} color={colors.subtle} />
      <Text style={styles.offeredText}>
        {clis.length === 1 ? cliName(clis[0]!) : t("cliPicker.offered", { clis: clis.map(cliName).join(", ") })}
      </Text>
    </View>
  );
}

function Chip({ label, active, several, title, onPress }: { label: string; active: boolean; several: boolean; title: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${label}`}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, pressed && { backgroundColor: colors.hover }]}
    >
      {several ? <Sparkles size={14} color={colors.accent} /> : <SquareTerminal size={14} color={active ? colors.accent : colors.muted} />}
      <Text style={[styles.chipText, active && { color: colors.fg }]} numberOfLines={1}>
        {label}
      </Text>
      <ChevronDown size={13} color={colors.subtle} />
    </Pressable>
  );
}

function Sheet({ open, onClose, title, hint, children }: { open: boolean; onClose: () => void; title: string; hint?: string; children: React.ReactNode }) {
  const t = useT();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} accessibilityLabel={t("common.close")} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
        <Text style={styles.sheetTitle}>{title}</Text>
        <View style={{ gap: 2 }}>{children}</View>
        {hint && <Text style={styles.hint}>{hint}</Text>}
        <Pressable accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.done, pressed && { opacity: 0.8 }]}>
          <Text style={styles.doneText}>{t("common.close")}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

function Option({
  kind,
  checked,
  title,
  note,
  onPress,
}: {
  kind: "radio" | "check";
  checked: boolean;
  title: string;
  note?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={kind === "radio" ? "radio" : "checkbox"}
      accessibilityState={{ checked }}
      onPress={onPress}
      style={({ pressed }) => [styles.option, pressed && { backgroundColor: colors.hover }]}
    >
      <View style={[styles.mark, kind === "radio" ? { borderRadius: 10 } : { borderRadius: 5 }, checked && styles.markOn]}>
        {checked && <Check size={13} strokeWidth={3} color={colors.ground} />}
      </View>
      <Text style={styles.optionText} numberOfLines={1}>
        {title}
      </Text>
      {note && <Text style={styles.optionNote}>{note}</Text>}
    </Pressable>
  );
}

function limitNote(cli: RunnerCli, t: ReturnType<typeof useT>): string | undefined {
  if (cli.limits?.status === "limited") return t("cliPicker.limited");
  if (cli.limits?.status === "warning") return t("cliPicker.nearLimit");
  return undefined;
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    maxWidth: 220,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginLeft: 4,
  },
  chipText: { color: colors.muted, fontSize: 13, flexShrink: 1 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: {
    gap: 12,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.edge,
    backgroundColor: colors.panel,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  sheetTitle: { color: colors.fg, fontSize: 16, fontWeight: "600" },
  hint: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
  option: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 12 },
  mark: { width: 20, height: 20, borderWidth: 1, borderColor: colors.edge, alignItems: "center", justifyContent: "center" },
  markOn: { borderColor: colors.accent, backgroundColor: colors.accent },
  optionText: { flex: 1, color: colors.body, fontSize: 15 },
  optionNote: { color: colors.subtle, fontSize: 13 },
  done: { alignItems: "center", borderRadius: radius.md, backgroundColor: colors.hover, paddingVertical: 12 },
  doneText: { color: colors.fg, fontSize: 15, fontWeight: "600" },
  note: {
    flexDirection: "row",
    gap: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 16,
    marginTop: 10,
  },
  noteText: { color: colors.body, fontSize: 13, lineHeight: 18 },
  noteReason: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
  offered: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  offeredText: { color: colors.subtle, fontSize: 12 },
});
