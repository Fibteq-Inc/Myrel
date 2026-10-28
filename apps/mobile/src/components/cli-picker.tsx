import type { MessageKey } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import { CLI_NAMES, CLOUD_RUNNER, type CliId, type CliModelDefaults, CloudCli, EFFORT_LEVELS, effortsFor, type ProjectWorkspace, type PromptSize, type RunnerCli, type Thread } from "@myrel/protocol";
import { cliMark } from "@myrel/client";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Cloud, Lock, SlidersHorizontal, Sparkles, SquareTerminal } from "lucide-react-native";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { runnersQueryKey, workspaceQueryKey } from "../lib/queries";
import { useSession } from "../lib/session";
import { makeStyles, radius, useColors } from "../theme";
import { ContextRing, ContextSection } from "./context-gauge";
import { CliMark } from "./ui";

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
/**
 * The project's local folders on the signed-in person's own computers (only those are listed by
 * listRunners), the default first. A thread of theirs works on one of these.
 */
export function useOwnWorkspaces(projectId: string): ProjectWorkspace[] {
  const { api, server } = useSession();
  const { data: workspace } = useQuery({ queryKey: workspaceQueryKey(server, projectId), queryFn: () => api.getWorkspace(projectId) });
  const { data: workspaces = [] } = useQuery({
    queryKey: [...workspaceQueryKey(server, projectId), "all"],
    queryFn: () => api.getWorkspaces(projectId),
    enabled: !!workspace,
  });
  const { data: runners } = useQuery({ queryKey: runnersQueryKey(server), queryFn: () => api.listRunners(), enabled: !!workspace });
  return workspaces.filter((w) => runners?.some((r) => r.id === w.runnerId));
}

/** `runnerId`: the computer the thread works on, when it was set to or started on one, or CLOUD_RUNNER. */
export function usePickableClis(projectId: string, runnerId?: string | null): Pickable | null {
  const { api, server } = useSession();
  const { data: default_, isPending } = useQuery({ queryKey: workspaceQueryKey(server, projectId), queryFn: () => api.getWorkspace(projectId) });
  const { data: runners } = useQuery({ queryKey: runnersQueryKey(server), queryFn: () => api.listRunners(), enabled: !!default_ });
  const { data: settings } = useQuery({
    queryKey: ["project-settings", server, projectId],
    queryFn: () => api.getProjectSettings(projectId),
  });
  const own = useOwnWorkspaces(projectId);
  if (isPending || !settings) return null;
  if (runnerId === CLOUD_RUNNER) return { clis: CLOUD_CLIS, folderCli: settings.cloudCli, defaults: {}, cloud: true };
  // The thread's computer, else the person's own (the default first), as the server picks it.
  const workspace = own.find((w) => w.runnerId === runnerId) ?? own[0] ?? default_;
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
      <Chip
        label={label}
        active={value.length > 0}
        several={value.length > 1}
        cli={value.length > 1 ? undefined : (value[0] ?? pickable.folderCli)}
        title={t("cliPicker.askTitle")}
        onPress={() => setOpen(true)}
      />
      <Sheet open={open} onClose={() => setOpen(false)} title={t("cliPicker.askTitle")} hint={[pickable.clis.length > 1 && t("cliPicker.askHint"), pickable.cloud && t("cliPicker.cloudHint")].filter(Boolean).join(" ") || undefined}>
        <Option kind="radio" checked={value.length === 0} title={t("cliPicker.default", { cli: cliName(pickable.folderCli) })} onPress={() => onChange([])} />
        {pickable.clis.map((c) => (
          <Option key={c.id} kind="check" checked={value.includes(c.id)} title={cliName(c.id)} cli={c.id} note={limitNote(c, t)} onPress={() => toggle(c.id)} />
        ))}
      </Sheet>
    </>
  );
}

/** Whether a thread can be placed at all: a project that always works in the cloud has nothing to place. */
export function usePlaceable(projectId: string): boolean {
  const { api, server } = useSession();
  const { data: settings } = useQuery({ queryKey: ["project-settings", server, projectId], queryFn: () => api.getProjectSettings(projectId) });
  return settings?.taskTarget !== "cloud";
}

/** An effort level's name; one Myrel does not know shows as the CLI wrote it. */
export function effortName(effort: string, t: ReturnType<typeof useT>): string {
  return (EFFORT_LEVELS as readonly string[]).includes(effort) ? t(`modelPicker.effort.${effort}` as MessageKey) : effort;
}

/**
 * The model and effort a thread's CLI runs with from its next turn, as on the web: the thread's own
 * pick, else the project's default for that CLI, else the CLI's. Only for a local CLI that lists its
 * models; efforts only those the model takes.
 */
function modelChoice(pickable: Pickable, thread: Thread) {
  const cli = (thread.cli?.id as CliId | undefined) ?? pickable.folderCli;
  // In the cloud the project's model runs whichever CLI it is.
  const models = pickable.cloud ? undefined : pickable.clis.find((c) => c.id === cli)?.models;
  if (!models?.length) return null;
  const own = thread.model?.cli === cli ? thread.model : null;
  const project = pickable.defaults[cli];
  const modelId = own?.model ?? project?.model ?? null;
  const model = modelId ? models.find((m) => m.id === modelId) : undefined;
  const efforts = effortsFor(models, model?.id ?? null);
  const effortId = own?.effort ?? project?.effort ?? null;
  const effort = effortId && efforts.includes(effortId) ? effortId : null;
  const projectModel = project?.model ? (models.find((m) => m.id === project.model)?.name ?? project.model) : null;
  const next = (change: { model?: string | null; effort?: string | null }) => {
    const m = change.model !== undefined ? change.model : (own?.model ?? null);
    let e = change.effort !== undefined ? change.effort : (own?.effort ?? null);
    if (e && !effortsFor(models, m ?? project?.model ?? null).includes(e)) e = null;
    return { cli, model: m, effort: e };
  };
  return { cli, models, own, model, efforts, effort, projectModel, next };
}

/**
 * Thread: one chip summing up where it works, its CLI, model and effort, opening one sheet to change
 * any of them from its next turn, as on the web. The sheet stays open across picks; the model list
 * opens inside it. Someone who can pick nothing sees it read-only. After the agent's first turn it
 * also shows how full that turn's prompt was.
 */
export function ThreadSettingsPicker({
  projectId,
  pickable,
  workspaces,
  placeable,
  thread,
  prompt,
  onRunner,
  onCli,
  onModel,
}: {
  projectId: string;
  pickable: Pickable | null;
  /** The person's own computers in the project, the default first. */
  workspaces: ProjectWorkspace[];
  /** The project does not always work in the cloud, so a thread can be moved. */
  placeable: boolean;
  thread: Thread;
  /** What the agent's prompt held on its last turn, once it had one. */
  prompt?: PromptSize | null;
  onRunner: (runnerId: string | null) => void;
  onCli: (cli: CliId | null) => void;
  onModel: (pick: { cli: CliId; model: string | null; effort: string | null }) => void;
}) {
  const t = useT();
  const styles = useStyles();
  const { api, server } = useSession();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState(false);
  const { data: folder } = useQuery({ queryKey: workspaceQueryKey(server, projectId), queryFn: () => api.getWorkspace(projectId) });
  const { data: all = [] } = useQuery({
    queryKey: [...workspaceQueryKey(server, projectId), "all"],
    queryFn: () => api.getWorkspaces(projectId),
    enabled: !!folder,
  });
  const { data: runners } = useQuery({ queryKey: runnersQueryKey(server), queryFn: () => api.listRunners(), enabled: !!folder });
  const { data: settings } = useQuery({ queryKey: ["project-settings", server, projectId], queryFn: () => api.getProjectSettings(projectId) });
  const close = () => {
    setOpen(false);
    setModels(false);
  };
  const cloud = thread.runner?.id === CLOUD_RUNNER;

  if (!pickable) {
    // Nothing to pick, e.g. a thread working on another member's computer: say what it runs with.
    // Not while what decides it still loads, or it would flash.
    if (!folder || !runners || !settings) return null;
    const computer = all.find((w) => w.runnerId === thread.runner?.id) ?? folder;
    const cli = thread.cli?.id ?? computer.cli;
    const own = thread.model?.cli === cli ? thread.model : null;
    const modelLabel = [own?.model, own?.effort && effortName(own.effort, t)].filter(Boolean).join(" · ");
    return (
      <>
        <Chip
          label={[cliName(cli), modelLabel].filter(Boolean).join(" · ")}
          active={false}
          prompt={prompt}
          title={t("threadSettings.title")}
          onPress={() => setOpen(true)}
        />
        <Sheet open={open} onClose={close} title={t("threadSettings.title")} hint={t("threadSettings.readOnly")}>
          <Text style={styles.section}>{t("threadSettings.where")}</Text>
          <Locked>{computer.runnerName}</Locked>
          <Text style={styles.section}>{t("threadSettings.cli")}</Text>
          <Locked cli={cli}>{cliName(cli)}</Locked>
          {modelLabel ? (
            <>
              <Text style={styles.section}>{t("threadSettings.model")}</Text>
              <Locked>{modelLabel}</Locked>
            </>
          ) : null}
          {prompt && <ContextSection prompt={prompt} />}
        </Sheet>
      </>
    );
  }

  // Where it works: the cloud or one of the person's computers in the project, for someone with the
  // project on one of theirs (else their turns work in the cloud anyway).
  const showRunner = placeable && (workspaces.length > 0 || cloud);
  // The coordinator's cloud counts as picked too: the default sends the thread back to a computer.
  const pickedRunner = thread.runner && thread.runner.by !== "auto" ? thread.runner.id : null;
  const computer = workspaces.find((w) => w.runnerId === thread.runner?.id) ?? workspaces[0];
  const currentCli = thread.cli?.id;
  const choice = modelChoice(pickable, thread);
  const active = !!pickedRunner || !!currentCli || !!choice?.own;
  const where = cloud ? t("runnerPicker.cloud") : showRunner && computer && computer !== workspaces[0] ? computer.runnerName : null;
  const label = [where, cliName(currentCli ?? pickable.folderCli), choice?.model?.name, choice?.effort && effortName(choice.effort, t)]
    .filter(Boolean)
    .join(" · ");
  const hint = [showRunner && cloud ? t("runnerPicker.hint") : t("cliPicker.threadHint"), pickable.cloud && t("cliPicker.cloudHint")].filter(Boolean).join(" ");

  return (
    <>
      <Chip
        label={label}
        active={active}
        several={thread.cli?.by === "coordinator"}
        cloud={cloud}
        settings
        prompt={prompt}
        title={t("threadSettings.title")}
        onPress={() => setOpen(true)}
      />
      <Sheet open={open} onClose={close} title={models ? t("threadSettings.model") : t("threadSettings.title")} hint={models ? undefined : hint}>
        {models && choice ? (
          <ScrollView style={{ maxHeight: 420 }}>
            <Option
              kind="radio"
              checked={!choice.own?.model}
              title={choice.projectModel ? t("modelPicker.projectDefault", { model: choice.projectModel }) : t("modelPicker.cliDefault")}
              onPress={() => {
                onModel(choice.next({ model: null }));
                setModels(false);
              }}
            />
            {choice.models.map((m) => (
              <Option
                key={m.id}
                kind="radio"
                checked={choice.own?.model === m.id}
                title={m.name}
                onPress={() => {
                  onModel(choice.next({ model: m.id }));
                  setModels(false);
                }}
              />
            ))}
          </ScrollView>
        ) : (
          <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ gap: 10 }}>
            {showRunner && (
              <>
                <Text style={styles.section}>{t("threadSettings.where")}</Text>
                <Pills>
                  <Pill
                    checked={!pickedRunner}
                    onPress={() => pickedRunner && onRunner(null)}
                    label={
                      thread.runner?.by === "auto" && computer
                        ? t("runnerPicker.started", { computer: computer.runnerName })
                        : workspaces[0]
                          ? t("cliPicker.default", { cli: workspaces[0].runnerName })
                          : t("runnerPicker.auto")
                    }
                  />
                  <Pill checked={cloud} onPress={() => !cloud && onRunner(CLOUD_RUNNER)} label={t("runnerPicker.cloud")} />
                  {workspaces.map((w) => (
                    <Pill
                      key={w.runnerId}
                      checked={pickedRunner === w.runnerId}
                      onPress={() => pickedRunner !== w.runnerId && onRunner(w.runnerId)}
                      label={w.online ? w.runnerName : `${w.runnerName} (${t("localFolder.offline")})`}
                    />
                  ))}
                </Pills>
              </>
            )}
            <Text style={styles.section}>{t("threadSettings.cli")}</Text>
            <Pills>
              <Pill checked={!currentCli} onPress={() => currentCli && onCli(null)} label={t("cliPicker.default", { cli: cliName(pickable.folderCli) })} />
              {pickable.clis.map((c) => {
                const note = limitNote(c, t);
                return (
                  <Pill
                    key={c.id}
                    checked={currentCli === c.id}
                    onPress={() => currentCli !== c.id && onCli(c.id)}
                    label={note ? `${cliName(c.id)} (${note})` : cliName(c.id)}
                    cli={c.id}
                  />
                );
              })}
            </Pills>
            <Text style={styles.section}>{t("threadSettings.model")}</Text>
            {pickable.cloud ? (
              <Locked>{t("threadSettings.cloudModel")}</Locked>
            ) : choice ? (
              <>
                <Option
                  kind="radio"
                  checked
                  title={choice.model?.name ?? choice.projectModel ?? t("modelPicker.cliDefault")}
                  note={t("threadSettings.change")}
                  onPress={() => setModels(true)}
                />
                <Text style={styles.section}>{t("modelPicker.effort")}</Text>
                {choice.efforts.length > 0 ? (
                  <Pills>
                    <Pill checked={!choice.own?.effort} onPress={() => onModel(choice.next({ effort: null }))} label={t("modelPicker.effortDefault")} />
                    {choice.efforts.map((e) => (
                      <Pill key={e} checked={choice.own?.effort === e} onPress={() => onModel(choice.next({ effort: e }))} label={effortName(e, t)} />
                    ))}
                  </Pills>
                ) : (
                  <Text style={styles.hint}>{t("modelPicker.noEffort")}</Text>
                )}
              </>
            ) : (
              <Text style={styles.hint}>{t("threadSettings.noModels")}</Text>
            )}
            {prompt && <ContextSection prompt={prompt} />}
          </ScrollView>
        )}
      </Sheet>
    </>
  );
}

function Pills({ children }: { children: React.ReactNode }) {
  const styles = useStyles();
  return <View style={styles.efforts}>{children}</View>;
}

/** `cli`: a CLI's pill, led by its mark. */
function Pill({ checked, onPress, label, cli }: { checked: boolean; onPress: () => void; label: string; cli?: string }) {
  const styles = useStyles();
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={({ pressed }) => [styles.effort, checked && styles.effortOn, pressed && !checked && { backgroundColor: colors.hover }]}
    >
      {cli && <CliMark cli={cli} size={14} color={checked ? colors.onAccent : colors.body} />}
      <Text style={[styles.effortText, checked && { color: colors.onAccent }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** `cli`: the CLI it names, shown by its mark. */
function Locked({ children, cli }: { children: React.ReactNode; cli?: string }) {
  const styles = useStyles();
  const colors = useColors();
  return (
    <View style={styles.locked}>
      <Lock size={14} color={colors.subtle} />
      {cli && <CliMark cli={cli} size={16} />}
      <Text style={styles.optionText} numberOfLines={1}>
        {children}
      </Text>
    </View>
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

/** The line at the top of a thread Myrel opened in the cloud, saying why. */
export function ThreadRunnerNote({ thread }: { thread: Thread }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const runner = thread.runner;
  if (runner?.id !== CLOUD_RUNNER || runner.by !== "coordinator") return null;
  return (
    <View style={styles.note}>
      <Cloud size={15} color={colors.accent} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.noteText}>{t("runnerPicker.coordinator")}</Text>
        {runner.reason && <Text style={styles.noteReason}>{runner.reason}</Text>}
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
  settings,
  cloud,
  cli,
  prompt,
  title,
  onPress,
}: {
  label: string;
  active: boolean;
  several?: boolean;
  /** The one CLI it stands for, shown by its mark. */
  cli?: string;
  settings?: boolean;
  cloud?: boolean;
  prompt?: PromptSize | null;
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
      {prompt && <ContextRing prompt={prompt} />}
      {several ? (
        <Sparkles size={14} color={colors.accent} />
      ) : cloud ? (
        <Cloud size={14} color={active ? colors.accent : colors.muted} />
      ) : settings ? (
        <SlidersHorizontal size={14} color={active ? colors.accent : colors.muted} />
      ) : cliMark(cli) ? (
        <CliMark cli={cli} size={14} color={active ? colors.accent : colors.muted} />
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

/** A bottom sheet of options, shared with the project settings. */
export function Sheet({ open, onClose, title, hint, children }: { open: boolean; onClose: () => void; title: string; hint?: string; children: React.ReactNode }) {
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

/** One choice in a Sheet. `wrap` lets a long title take more than one line. */
export function Option({
  kind,
  checked,
  title,
  note,
  wrap,
  cli,
  onPress,
}: {
  kind: "radio" | "check";
  checked: boolean;
  title: string;
  note?: string;
  wrap?: boolean;
  /** A CLI's option, led by its mark. */
  cli?: string;
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
      {cli && <CliMark cli={cli} size={18} />}
      <Text style={styles.optionText} numberOfLines={wrap ? undefined : 1}>
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
    effort: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.edge, paddingHorizontal: 12, paddingVertical: 7 },
    effortOn: { borderColor: colors.accent, backgroundColor: colors.accent },
    effortText: { color: colors.body, fontSize: 13 },
    locked: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, paddingVertical: 4 },
  }),
);
