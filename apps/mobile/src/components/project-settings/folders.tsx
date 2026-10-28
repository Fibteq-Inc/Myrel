import type { Translate } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import { CLI_NAMES, type CliId, type Project, type ProjectWorkspace, type Runner } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { ArrowUp, Check, ChevronRight, Folder, FolderPlus, House, X } from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { runnersQueryKey, workspaceQueryKey } from "../../lib/queries";
import { useSession } from "../../lib/session";
import { makeStyles, mono, radius, useColors } from "../../theme";
import { Notice, Section } from "../settings-section";
import { Button, errorMessage, Input, Spinner } from "../ui";

/** Whether this computer can browse and share folders from the app right now, and why not (as on the web). */
function folderPickerBlocker(runner: Runner, t: Translate): string | null {
  if (!runner.online) return t("folderPicker.offline", { computer: runner.name });
  if (!runner.features.includes("folders")) return t("folderPicker.updateRunner", { command: "npx myrel-runner@latest update" });
  return null;
}

function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** Everything that reads the project's folders or the person's computers refreshes after a change. */
function useRefreshFolders(projectId: string) {
  const { server } = useSession();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: workspaceQueryKey(server, projectId) }),
      queryClient.invalidateQueries({ queryKey: runnersQueryKey(server) }),
    ]);
}

/**
 * The folders on the person's computer the project's agent may work in: its main folder and any
 * others, as in the web's Folders tab. Anything outside them, Claude Code asks about in the thread first.
 */
export function FolderSettings({ project, canManage }: { project: Project; canManage: boolean }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const refresh = useRefreshFolders(project.id);
  const { data: workspace, isPending } = useQuery({ queryKey: workspaceQueryKey(server, project.id), queryFn: () => api.getWorkspace(project.id) });
  const { data: runners = [] } = useQuery({ queryKey: runnersQueryKey(server), queryFn: () => api.listRunners(), enabled: canManage });
  // connect: the main folder form; pick: browsing for another folder.
  const [mode, setMode] = useState<"idle" | "connect" | "pick">("idle");
  const add = useMutation({
    mutationFn: (path: string) => api.addWorkspaceFolder(project.id, path),
    onSuccess: async () => {
      setMode("idle");
      await refresh();
    },
  });
  const remove = useMutation({ mutationFn: (path: string) => api.removeWorkspaceFolder(project.id, path), onSuccess: refresh });

  if (isPending) {
    return (
      <View style={styles.center}>
        <Spinner />
      </View>
    );
  }
  const hint = canManage ? t("projectFolders.description") : `${t("projectFolders.description")} ${t("projectFolders.readOnly")}`;

  if (!workspace || mode === "connect") {
    return (
      <Section title={t("projectFolders.title")} hint={hint}>
        {mode === "connect" ? (
          <WorkspaceForm project={project} workspace={workspace ?? null} onDone={() => setMode("idle")} />
        ) : (
          <View style={{ gap: 10 }}>
            <Text style={styles.sub}>{t("projectFolders.cloud")}</Text>
            {canManage && <Button onPress={() => setMode("connect")}>{t("projectFolders.connect")}</Button>}
          </View>
        )}
      </Section>
    );
  }

  const runner = runners.find((r) => r.id === workspace.runnerId);
  const blocker = runner ? folderPickerBlocker(runner, t) : null;
  const cli = CLI_NAMES[workspace.cli] ?? workspace.cli;
  const confirmRemove = (path: string) =>
    Alert.alert(t("projectFolders.remove", { path }), undefined, [
      { text: t("mobile.cancel"), style: "cancel" },
      { text: t("members.remove"), style: "destructive", onPress: () => remove.mutate(path) },
    ]);

  return (
    <Section title={t("projectFolders.title")} hint={hint}>
      <View style={styles.row}>
        <Folder size={16} color={colors.muted} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={styles.titleLine}>
            <OnlineDot online={workspace.online} />
            <Text style={styles.name} numberOfLines={1}>
              {folderName(workspace.path)}
            </Text>
          </View>
          <Text style={styles.sub}>
            {t("projectFolders.main")} · {t("projectFolders.mainHint", { computer: workspace.runnerName, cli })}
          </Text>
          <FolderPath path={workspace.path} />
        </View>
        {canManage && (
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setMode("connect")}>
            <Text style={styles.action}>{t("projectFolders.change")}</Text>
          </Pressable>
        )}
      </View>
      {workspace.folders.map((path) => (
        <View key={path} style={styles.row}>
          <Folder size={16} color={colors.subtle} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.name} numberOfLines={1}>
              {folderName(path)} <Text style={styles.sub}>{t("projectFolders.other")}</Text>
            </Text>
            <FolderPath path={path} />
          </View>
          {canManage && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("projectFolders.remove", { path })}
              hitSlop={8}
              disabled={remove.isPending}
              onPress={() => confirmRemove(path)}
            >
              <X size={16} color={colors.subtle} />
            </Pressable>
          )}
        </View>
      ))}
      <Text style={[styles.sub, { marginTop: 4 }]}>
        {workspace.cli === "claude" ? t("projectFolders.asksClaude") : t("projectFolders.asksOther", { cli })}
      </Text>
      {canManage &&
        runner &&
        (blocker ? (
          <Text style={[styles.sub, { marginTop: 4 }]}>{blocker}</Text>
        ) : (
          <Button variant="ghost" onPress={() => setMode("pick")} style={{ marginTop: 8 }}>
            {t("projectFolders.add")}
          </Button>
        ))}
      {(add.error || remove.error) && <Notice tone="bad">{errorMessage(add.error ?? remove.error, t("common.error"))}</Notice>}
      {mode === "pick" && runner && (
        <FolderPicker runner={runner} onShared={(path) => add.mutate(path)} onCancel={() => setMode("idle")} />
      )}
    </Section>
  );
}

/** Connects or changes the project's folder on one of the person's computers, as the web's WorkspaceForm. */
function WorkspaceForm({ project, workspace, onDone }: { project: Project; workspace: ProjectWorkspace | null; onDone: () => void }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const refresh = useRefreshFolders(project.id);
  const { data: runners = [], isPending } = useQuery({ queryKey: runnersQueryKey(server), queryFn: () => api.listRunners() });
  const { data: workspaces = [] } = useQuery({
    queryKey: [...workspaceQueryKey(server, project.id), "all"],
    queryFn: () => api.getWorkspaces(project.id),
  });
  const [runnerId, setRunnerId] = useState(workspace?.runnerId ?? "");
  const [pickedPath, setPath] = useState(workspace?.path ?? "");
  const [pickedCli, setCli] = useState<CliId | "">(workspace?.cli ?? "");
  const [browsing, setBrowsing] = useState(false);

  // Fall back to the first computer, its first folder and its first CLI.
  const runner = runners.find((r) => r.id === runnerId) ?? runners[0];
  const path = runner?.folders.some((f) => f.path === pickedPath) ? pickedPath : (runner?.folders[0]?.path ?? "");
  const cli = runner?.clis.some((c) => c.id === pickedCli) ? pickedCli : (runner?.clis[0]?.id ?? "");
  // This computer's local folder in the project, when it has one: the form changes that one.
  const inProject = workspaces.find((w) => w.runnerId === runner?.id);
  const pickRunner = (id: string) => {
    const w = workspaces.find((x) => x.runnerId === id);
    setRunnerId(id);
    setPath(w?.path ?? "");
    setCli(w?.cli ?? "");
  };
  const done = async () => {
    await refresh();
    onDone();
  };
  // A computer's folder goes next to the project's others; the first one is the default.
  const save = useMutation({
    mutationFn: () => api.setWorkspace(project.id, { runnerId: runner!.id, path, cli: cli as CliId, add: true }),
    onSuccess: done,
  });
  const clear = useMutation({ mutationFn: () => api.clearWorkspace(project.id, runner!.id), onSuccess: done });
  const makeDefault = useMutation({ mutationFn: () => api.setDefaultWorkspace(project.id, runner!.id), onSuccess: done });

  if (isPending) {
    return (
      <View style={styles.center}>
        <Spinner />
      </View>
    );
  }
  if (!runner) {
    return (
      <View style={{ gap: 10 }}>
        <Text style={styles.body}>{t("localFolder.connectFirst")}</Text>
        {/* Connecting a computer happens on Devices, which the phone app does not have yet. */}
        <Button onPress={() => void WebBrowser.openBrowserAsync(`${server}/devices`)}>{t("localFolder.connectComputer")}</Button>
        <Button variant="ghost" onPress={onDone}>
          {t("folderPicker.cancel")}
        </Button>
      </View>
    );
  }
  const blocker = folderPickerBlocker(runner, t);
  const error = save.error ?? clear.error ?? makeDefault.error;

  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 4 }}>
        <Text style={styles.heading}>{t("localFolder.title")}</Text>
        <Text style={styles.sub}>{workspace ? t("localFolder.intro") : t("localFolder.introCloud")}</Text>
        {workspaces.length > 1 && <Text style={styles.sub}>{t("localFolder.severalHint")}</Text>}
      </View>

      {runners.length > 1 && (
        <Field label={t("localFolder.computer")}>
          {runners.map((r) => {
            const w = workspaces.find((x) => x.runnerId === r.id);
            return (
              <Choice key={r.id} checked={r.id === runner.id} onPress={() => pickRunner(r.id)}>
                <Text style={[styles.name, { flexShrink: 1 }]} numberOfLines={1}>
                  {r.name}
                </Text>
                {w && (
                  <Text style={styles.badge}>{workspaces.length > 1 && w.isDefault ? t("localFolder.default") : t("localFolder.inProject")}</Text>
                )}
                <View style={{ flex: 1 }} />
                <OnlineDot online={r.online} />
              </Choice>
            );
          })}
        </Field>
      )}

      <Field label={runners.length > 1 ? t("localFolder.folder") : t("localFolder.folderOn", { computer: runner.name })}>
        {runner.folders.map((f) => (
          <Choice key={f.path} checked={f.path === path} onPress={() => setPath(f.path)}>
            <Folder size={14} color={colors.subtle} />
            <Text style={styles.path} numberOfLines={1} ellipsizeMode="head">
              {f.path}
            </Text>
          </Choice>
        ))}
        {blocker ? (
          runner.folders.length === 0 && <Text style={styles.sub}>{t("localFolder.noFolders", { reason: blocker })}</Text>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => setBrowsing(true)}
            style={({ pressed }) => [styles.browse, pressed && { backgroundColor: colors.hover }]}
          >
            <FolderPlus size={14} color={colors.muted} />
            <Text style={styles.muted}>{runner.folders.length === 0 ? t("localFolder.chooseFolder") : t("localFolder.addFolder")}</Text>
          </Pressable>
        )}
      </Field>

      <Field label={t("localFolder.cli")}>
        {runner.clis.length === 0 ? (
          <Text style={styles.sub}>{runner.online ? t("localFolder.noClis") : t("localFolder.startRunner")}</Text>
        ) : (
          <View style={styles.chips}>
            {runner.clis.map((c) => {
              const on = c.id === cli;
              return (
                <Pressable
                  key={c.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  onPress={() => setCli(c.id)}
                  style={[styles.chip, on && styles.chipOn]}
                >
                  <Text style={[styles.muted, on && { color: colors.fg }]}>{CLI_NAMES[c.id] ?? c.id}</Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </Field>

      {!runner.online && (
        <View style={styles.titleLine}>
          <OnlineDot online={false} />
          <Text style={[styles.sub, { flex: 1 }]}>
            {t("localFolder.runnerOffline", { computer: runner.name, command: "npx myrel-runner service install" })}
          </Text>
        </View>
      )}
      {error && <Notice tone="bad">{errorMessage(error, t("common.error"))}</Notice>}

      <View style={{ gap: 8 }}>
        <Button onPress={() => save.mutate()} pending={save.isPending} disabled={!path || !cli}>
          {inProject ? t("localFolder.save") : workspace ? t("localFolder.addComputer") : t("localFolder.useFolder")}
        </Button>
        {inProject && !inProject.isDefault && (
          <Button variant="ghost" onPress={() => makeDefault.mutate()} pending={makeDefault.isPending}>
            {t("localFolder.makeDefault")}
          </Button>
        )}
        {inProject && (
          <Button variant="ghost" onPress={() => clear.mutate()} pending={clear.isPending}>
            {t("localFolder.disconnect")}
          </Button>
        )}
        <Button variant="ghost" onPress={onDone}>
          {t("folderPicker.cancel")}
        </Button>
      </View>

      {browsing && (
        <FolderPicker
          runner={runner}
          onShared={(shared) => {
            setPath(shared);
            setBrowsing(false);
          }}
          onCancel={() => setBrowsing(false)}
        />
      )}
    </View>
  );
}

/**
 * A full-screen browser of a computer's folders through its runner, sharing the one picked.
 * Only folder names are fetched, never files.
 */
function FolderPicker({ runner, onShared, onCancel }: { runner: Runner; onShared: (path: string) => void; onCancel: () => void }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  // undefined: the computer's home folder.
  const [path, setPath] = useState<string | undefined>();
  const [typed, setTyped] = useState<string | null>(null);
  const listing = useQuery({
    queryKey: [...runnersQueryKey(server), runner.id, "dirs", path ?? ""],
    queryFn: () => api.listRunnerDirs(runner.id, path),
    retry: false,
  });
  const share = useMutation({
    mutationFn: (folder: string) => api.shareRunnerFolder(runner.id, folder),
    onSuccess: async (_folders, folder) => {
      await queryClient.invalidateQueries({ queryKey: runnersQueryKey(server), exact: true });
      onShared(folder);
    },
  });

  const current = listing.data;
  const shared = new Set(runner.folders.map((f) => f.path));
  // The home folder and the disk root are too broad to hand to a project.
  const tooBroad = !current || current.path === current.home || current.parent === null;
  const go = (next: string | undefined) => {
    setTyped(null);
    share.reset();
    setPath(next);
  };
  const label = current ? folderName(current.path) : "";

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle} numberOfLines={1}>
            {runner.name}
          </Text>
          <Pressable accessibilityRole="button" hitSlop={10} onPress={onCancel}>
            <Text style={[styles.name, { color: colors.accent }]}>{t("folderPicker.cancel")}</Text>
          </Pressable>
        </View>
        <View style={styles.titleLine}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("folderPicker.upLabel")}
            hitSlop={6}
            disabled={!current?.parent}
            onPress={() => current?.parent && go(current.parent)}
            style={[styles.iconButton, !current?.parent && { opacity: 0.4 }]}
          >
            <ArrowUp size={16} color={colors.fg} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={t("folderPicker.homeLabel")} hitSlop={6} onPress={() => go(undefined)} style={styles.iconButton}>
            <House size={16} color={colors.fg} />
          </Pressable>
          <Input
            accessibilityLabel={t("folderPicker.path")}
            value={typed ?? current?.path ?? path ?? ""}
            onChangeText={setTyped}
            onSubmitEditing={() => typed?.trim() && go(typed.trim())}
            returnKeyType="go"
            style={{ flex: 1, fontFamily: mono, fontSize: 13, minHeight: 40 }}
          />
        </View>

        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {listing.isPending ? (
            <Text style={styles.listNote}>{t("folderPicker.loading")}</Text>
          ) : listing.error ? (
            <Text style={[styles.listNote, { color: colors.bad }]}>{errorMessage(listing.error, t("common.error"))}</Text>
          ) : current!.dirs.length === 0 ? (
            <Text style={styles.listNote}>{t("folderPicker.empty")}</Text>
          ) : (
            current!.dirs.map((d) => (
              <Pressable
                key={d.path}
                accessibilityRole="button"
                onPress={() => go(d.path)}
                style={({ pressed }) => [styles.dir, pressed && { backgroundColor: colors.hover }]}
              >
                <Folder size={15} color={colors.subtle} />
                <Text style={[styles.name, { flex: 1 }]} numberOfLines={1}>
                  {d.name}
                </Text>
                {shared.has(d.path) && (
                  <View style={styles.titleLine}>
                    <Check size={12} color={colors.ok} />
                    <Text style={[styles.sub, { color: colors.ok }]}>{t("folderPicker.shared")}</Text>
                  </View>
                )}
                <ChevronRight size={15} color={colors.subtle} />
              </Pressable>
            ))
          )}
        </ScrollView>

        {share.error && <Notice tone="bad">{errorMessage(share.error, t("common.error"))}</Notice>}
        {current && tooBroad && <Text style={styles.sub}>{t("folderPicker.tooBroad")}</Text>}
        {current && shared.has(current.path) ? (
          <Button onPress={() => onShared(current.path)}>{t("folderPicker.alreadyShared")}</Button>
        ) : (
          <Button disabled={tooBroad} pending={share.isPending} onPress={() => current && share.mutate(current.path)}>
            {current && !tooBroad ? t("folderPicker.shareNamed", { name: label.length > 18 ? `${label.slice(0, 17)}…` : label }) : t("folderPicker.share")}
          </Button>
        )}
      </View>
    </Modal>
  );
}

/** A long path keeps its end in view: that is the part that tells folders apart. */
function FolderPath({ path }: { path: string }) {
  const styles = useStyles();
  return (
    <Text style={styles.path} numberOfLines={1} ellipsizeMode="head">
      {path}
    </Text>
  );
}

function OnlineDot({ online }: { online: boolean }) {
  const colors = useColors();
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: online ? colors.ok : colors.subtle }} />;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

function Choice({ checked, onPress, children }: { checked: boolean; onPress: () => void; children: ReactNode }) {
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked }} onPress={onPress} style={[styles.choice, checked && styles.chipOn]}>
      {children}
    </Pressable>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    center: { alignItems: "center", paddingVertical: 16 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
    titleLine: { flexDirection: "row", alignItems: "center", gap: 6 },
    heading: { color: colors.fg, fontSize: 15, fontWeight: "600" },
    name: { color: colors.fg, fontSize: 15 },
    body: { color: colors.body, fontSize: 14, lineHeight: 20 },
    sub: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    muted: { color: colors.muted, fontSize: 14 },
    label: { color: colors.subtle, fontSize: 12 },
    action: { color: colors.accent, fontSize: 14, fontWeight: "500" },
    path: { flexShrink: 1, color: colors.subtle, fontFamily: mono, fontSize: 12 },
    badge: { color: colors.muted, fontSize: 11, backgroundColor: colors.hover, borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden" },
    choice: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: "transparent",
      paddingHorizontal: 10,
      paddingVertical: 10,
    },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    chip: { borderRadius: radius.sm, borderWidth: 1, borderColor: colors.edge, paddingHorizontal: 10, paddingVertical: 8 },
    chipOn: { borderColor: colors.accentBorder, backgroundColor: colors.accentSoft },
    browse: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.edge,
      paddingHorizontal: 10,
      paddingVertical: 10,
    },
    sheet: { flex: 1, gap: 12, backgroundColor: colors.ground, padding: 16 },
    sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    sheetTitle: { flex: 1, color: colors.fg, fontSize: 17, fontWeight: "600" },
    iconButton: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.edge,
    },
    list: { flex: 1, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.panel },
    listNote: { color: colors.subtle, fontSize: 14, padding: 12 },
    dir: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 12 },
  }),
);

