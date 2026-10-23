import type { MessageKey } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import { CLI_NAMES, type CliId, type CliModelDefaults, CloudCli, EFFORT_LEVELS, effortsFor, type RunnerCli, type Thread } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { Brain, Check, ChevronDown, Sparkles, SquareTerminal } from "lucide-react-native";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { runnersQueryKey, workspaceQueryKey } from "../lib/queries";
import { useSession } from "../lib/session";
import { makeStyles, radius, useColors } from "../theme";

/** cloud: the person's threads run in the cloud, where the choice is among the cloud CLIs. */
export type Pickable = { clis: RunnerCli[]; folderCli: CliId; defaults: CliModelDefaults; cloud?: boolean };

const CLOUD_CLIS: RunnerCli[] = CloudCli.options.map((id) => ({ id, version: null }));

export function cliName(id: string): string {
  return CLI_NAMES[id as CliId] ?? id;
}

/**
 * The CLIs the signed-in person can pick for this project's threads, as on the web: those on the
 * project folder's computer when it is theirs and the project does not always work in the cloud;
 * otherwise the cloud CLIs, with the project's "CLI in the cloud" as the default. Null when there
 * is nothing to pick.
 */
export function usePickableClis(projectId: string): Pickable | null {
  const { api, server } = useSession();
  const { data: workspace, isPending } = useQuery({ queryKey: workspaceQueryKey(server, projectId), queryFn: () => api.getWorkspace(projectId) });
  const { data: runners } = useQuery({ queryKey: runnersQueryKey(server), queryFn: () => api.listRunners(), enabled: !!workspace });
  const { data: settings } = useQuery({
    queryKey: ["project-settings", server, projectId],
    queryFn: () => api.getProjectSettings(projectId),
  });
  if (isPending || !settings) return null;
  // Only your own computers are listed, so finding it means it is yours.
  const runner = workspace && runners?.find((r) => r.id === workspace.runnerId);
  const cloud = settings.taskTarget === "cloud" || !workspace || (settings.taskTarget === "auto" && runners !== undefined && !runner);
  if (cloud) return { clis: CLOUD_CLIS, folderCli: settings.cloudCli, defaults: {}, cloud: true };
  if (!runner || runner.clis.length === 0) return null;
  return { clis: runner.clis, folderCli: workspace.cli, defaults: settings.cliModels };
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
      <Sheet open={open} onClose={() => setOpen(false)} title={t("cliPicker.askTitle")} hint={[pickable.clis.length > 1 && t("cliPicker.askHint"), pickable.cloud && t("cliPicker.cloudHint")].filter(Boolean).join(" ") || undefined}>
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
      <Sheet open={open} onClose={() => setOpen(false)} title={t("cliPicker.threadTitle")} hint={pickable.cloud ? `${t("cliPicker.threadHint")} ${t("cliPicker.cloudHint")}` : t("cliPicker.threadHint")}>
        <Option kind="radio" checked={!current} title={t("cliPicker.default", { cli: cliName(pickable.folderCli) })} onPress={() => pick(null)} />
        {pickable.clis.map((c) => (
          <Option key={c.id} kind="radio" checked={current === c.id} title={cliName(c.id)} note={limitNote(c, t)} onPress={() => pick(c.id)} />
        ))}
      </Sheet>
    </>
  );
}

/** An effort level's name; one Myrel does not know shows as the CLI wrote it. */
function effortName(effort: string, t: ReturnType<typeof useT>): string {
  return (EFFORT_LEVELS as readonly string[]).includes(effort) ? t(`modelPicker.effort.${effort}` as MessageKey) : effort;
}

/**
 * Thread: the model and effort its CLI runs with from the next turn, as on the web. Only for a CLI
 * that lists its models; efforts only those the model takes, none for a model that takes none.
 */
export function ThreadModelPicker({
  pickable,
  thread,
  onChange,
}: {
  pickable: Pickable;
  thread: Thread;
  onChange: (pick: { cli: CliId; model: string | null; effort: string | null }) => void;
}) {
  const t = useT();
  const styles = useStyles();
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const cli = (thread.cli?.id as CliId | undefined) ?? pickable.folderCli;
  // In the cloud the project's model runs whichever CLI it is.
  const models = pickable.cloud ? undefined : pickable.clis.find((c) => c.id === cli)?.models;
  if (!models?.length) return null;
  const own = thread.model?.cli === cli ? thread.model : null;
  const project = pickable.defaults[cli];
  const model = models.find((m) => m.id === (own?.model ?? project?.model));
  const efforts = effortsFor(models, model?.id ?? null);
  const effortId = own?.effort ?? project?.effort ?? null;
  const effort = effortId && efforts.includes(effortId) ? effortId : null;
  const pick = (next: { model?: string | null; effort?: string | null }) => {
    const m = next.model !== undefined ? next.model : (own?.model ?? null);
    let e = next.effort !== undefined ? next.effort : (own?.effort ?? null);
    if (e && !effortsFor(models, m ?? project?.model ?? null).includes(e)) e = null;
    onChange({ cli, model: m, effort: e });
  };
  const label = [model?.name ?? t("modelPicker.cliDefault"), effort && effortName(effort, t)].filter(Boolean).join(" · ");
  const projectModel = project?.model ? (models.find((m) => m.id === project.model)?.name ?? project.model) : null;
  return (
    <>
      <Chip label={label} active={!!own} several={false} model title={t("modelPicker.title")} onPress={() => setOpen(true)} />
      <Sheet open={open} onClose={() => setOpen(false)} title={t("modelPicker.title")} hint={t("cliPicker.threadHint")}>
        <ScrollView style={{ maxHeight: 320 }}>
          <Option
            kind="radio"
            checked={!own?.model}
            title={projectModel ? t("modelPicker.projectDefault", { model: projectModel }) : t("modelPicker.cliDefault")}
            onPress={() => pick({ model: null })}
          />
          {models.map((m) => (
            <Option key={m.id} kind="radio" checked={own?.model === m.id} title={m.name} onPress={() => pick({ model: m.id })} />
          ))}
        </ScrollView>
        <Text style={styles.section}>{t("modelPicker.effort")}</Text>
        {efforts.length > 0 ? (
          <View style={styles.efforts}>
            {[null, ...efforts].map((e) => {
              const on = (own?.effort ?? null) === e;
              return (
                <Pressable
                  key={e ?? ""}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  onPress={() => pick({ effort: e })}
                  style={({ pressed }) => [styles.effort, on && styles.effortOn, pressed && !on && { backgroundColor: colors.hover }]}
                >
                  <Text style={[styles.effortText, on && { color: colors.onAccent }]}>{e ? effortName(e, t) : t("modelPicker.effortDefault")}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Text style={styles.hint}>{t("modelPicker.noEffort")}</Text>
        )}
      </Sheet>
    </>
  );
}

/** The note at the top of a thread whose CLI Myrel picked among the ones the person offered. */
export function ThreadCliNote({ thread }: { thread: Thread }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
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
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.offered}>
      <SquareTerminal size={13} color={colors.subtle} />
      <Text style={styles.offeredText}>
        {clis.length === 1 ? cliName(clis[0]!) : t("cliPicker.offered", { clis: clis.map(cliName).join(", ") })}
      </Text>
    </View>
  );
}

function Chip({
  label,
  active,
  several,
  model,
  title,
  onPress,
}: {
  label: string;
  active: boolean;
  several: boolean;
  model?: boolean;
  title: string;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${label}`}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, pressed && { backgroundColor: colors.hover }]}
    >
      {several ? (
        <Sparkles size={14} color={colors.accent} />
      ) : model ? (
        <Brain size={14} color={active ? colors.accent : colors.muted} />
      ) : (
        <SquareTerminal size={14} color={active ? colors.accent : colors.muted} />
      )}
      <Text style={[styles.chipText, active && { color: colors.fg }]} numberOfLines={1}>
        {label}
      </Text>
      <ChevronDown size={13} color={colors.subtle} />
    </Pressable>
  );
}

function Sheet({ open, onClose, title, hint, children }: { open: boolean; onClose: () => void; title: string; hint?: string; children: React.ReactNode }) {
  const t = useT();
  const styles = useStyles();
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
  const colors = useColors();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole={kind === "radio" ? "radio" : "checkbox"}
      accessibilityState={{ checked }}
      onPress={onPress}
      style={({ pressed }) => [styles.option, pressed && { backgroundColor: colors.hover }]}
    >
      <View style={[styles.mark, kind === "radio" ? { borderRadius: 10 } : { borderRadius: 5 }, checked && styles.markOn]}>
        {checked && <Check size={13} strokeWidth={3} color={colors.onAccent} />}
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

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
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
    backdrop: { flex: 1, backgroundColor: colors.scrim },
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
    section: { color: colors.subtle, fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 },
    efforts: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    effort: { borderRadius: 999, borderWidth: 1, borderColor: colors.edge, paddingHorizontal: 12, paddingVertical: 7 },
    effortOn: { borderColor: colors.accent, backgroundColor: colors.accent },
    effortText: { color: colors.body, fontSize: 13 },
  }),
);
