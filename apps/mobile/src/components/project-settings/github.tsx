import { ApiError } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { GithubRepo, ProjectRepo } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { ExternalLink, FolderGit2, GitBranch, Lock, Plus, Search, Trash2 } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, AppState, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../../lib/session";
import { makeStyles, radius, useColors } from "../../theme";
import { Notice, Section } from "../settings-section";
import { Button, errorMessage, Input, Spinner } from "../ui";

/** The server wants a fresh GitHub sign-in before repositories are picked (see GITHUB_GRANT_TTL_MS). */
function needsGithubSignIn(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && (err.body as { error?: string } | null)?.error === "github_reauth";
}

/**
 * The project's GitHub repositories, as on the web. Connecting GitHub needs the browser's signed-in
 * session, so it happens on the project's web settings page in the browser; coming back to the app
 * reads the lists again.
 */
export function GithubSettings({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["github", server], queryFn: () => api.getGithubStatus() });
  const reposKey = ["projects", server, projectId, "repos"];
  const repos = useQuery({ queryKey: reposKey, queryFn: () => api.listProjectRepos(projectId) });
  const [picking, setPicking] = useState(false);
  const remove = useMutation({
    mutationFn: (repoId: number) => api.removeProjectRepo(projectId, repoId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reposKey }),
  });

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void queryClient.invalidateQueries({ queryKey: ["github", server] });
    });
    return () => sub.remove();
  }, [queryClient, server]);

  const openWeb = async () => {
    await WebBrowser.openBrowserAsync(`${server}/settings/projects/${encodeURIComponent(projectId)}?tab=github`);
    void queryClient.invalidateQueries({ queryKey: ["github", server] });
    void queryClient.invalidateQueries({ queryKey: reposKey });
  };

  const confirmRemove = (r: ProjectRepo) =>
    Alert.alert(t("github.disconnectLabel", { repo: r.fullName }), undefined, [
      { text: t("mobile.cancel"), style: "cancel" },
      { text: t("github.disconnect"), style: "destructive", onPress: () => remove.mutate(r.repoId) },
    ]);

  const installed = !!status.data?.installations.length;

  return (
    <Section title={t("github.title")} hint={t("github.description")}>
      {status.isPending || repos.isPending ? (
        <View style={styles.center}>
          <Spinner />
        </View>
      ) : status.data && !status.data.configured ? (
        <Notice>{t("github.notConfigured", { path: "apps/api/src/github/README.md" })}</Notice>
      ) : (
        <>
          {repos.data?.length ? (
            repos.data.map((r) => (
              <View key={r.repoId} style={styles.row}>
                <FolderGit2 size={17} color={colors.muted} />
                <Pressable style={{ flex: 1, gap: 2 }} accessibilityRole="link" onPress={() => void Linking.openURL(`https://github.com/${r.fullName}`)}>
                  <Text style={styles.name} numberOfLines={1}>
                    {r.fullName}
                  </Text>
                  <View style={styles.meta}>
                    <GitBranch size={12} color={colors.subtle} />
                    <Text style={styles.sub}>{r.defaultBranch}</Text>
                    {r.private && (
                      <>
                        <Lock size={12} color={colors.subtle} />
                        <Text style={styles.sub}>{t("github.private")}</Text>
                      </>
                    )}
                  </View>
                </Pressable>
                {canManage && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("github.disconnectLabel", { repo: r.fullName })}
                    hitSlop={8}
                    disabled={remove.isPending}
                    onPress={() => confirmRemove(r)}
                  >
                    <Trash2 size={16} color={colors.subtle} />
                  </Pressable>
                )}
              </View>
            ))
          ) : (
            <Text style={styles.sub}>{t("github.empty")}</Text>
          )}
          {remove.error && <Notice tone="bad">{errorMessage(remove.error, t("common.error"))}</Notice>}
          {canManage &&
            (installed ? (
              <Button variant="ghost" onPress={() => setPicking(true)} style={{ marginTop: 6 }}>
                {t("github.add")}
              </Button>
            ) : (
              <View style={{ gap: 10, marginTop: 6 }}>
                <Text style={styles.sub}>{t("github.installHint")}</Text>
                <Button onPress={() => void openWeb()}>{t("github.connect")}</Button>
              </View>
            ))}
          {installed && (
            <View style={{ gap: 2, marginTop: 6 }}>
              <Text style={styles.sub}>
                {t("github.connectedAccounts", { accounts: status.data!.installations.map((i) => i.accountLogin).join(", ") })}
              </Text>
              {canManage && (
                <Pressable accessibilityRole="link" onPress={() => void openWeb()} style={styles.link}>
                  <ExternalLink size={13} color={colors.subtle} />
                  <Text style={styles.sub}>{t("github.addAccount")}</Text>
                </Pressable>
              )}
            </View>
          )}
        </>
      )}
      {picking && <RepoPicker projectId={projectId} connected={repos.data ?? []} onSignIn={() => void openWeb()} onClose={() => setPicking(false)} />}
    </Section>
  );
}

/** A full-height sheet listing the repositories the GitHub app can see; a tap adds one. */
function RepoPicker({
  projectId,
  connected,
  onSignIn,
  onClose,
}: {
  projectId: string;
  connected: ProjectRepo[];
  onSignIn: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const available = useQuery({
    queryKey: ["github", server, "repos"],
    queryFn: () => api.listGithubRepos(),
    retry: (n, err) => !needsGithubSignIn(err) && n < 3,
  });
  const add = useMutation({
    mutationFn: (repo: GithubRepo) => api.addProjectRepo(projectId, { installationId: repo.installationId, repoId: repo.id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects", server, projectId, "repos"] }),
  });
  const signIn = needsGithubSignIn(available.error) || needsGithubSignIn(add.error);
  // Coming back from signing in again in the browser asks GitHub again.
  const { refetch } = available;
  const { reset } = add;
  useEffect(() => {
    if (!signIn) return;
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      reset();
      void refetch();
    });
    return () => sub.remove();
  }, [signIn, refetch, reset]);

  const taken = new Set(connected.map((r) => r.repoId));
  const q = filter.trim().toLowerCase();
  const matches = (available.data ?? []).filter((r) => !taken.has(r.id) && r.fullName.toLowerCase().includes(q));

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>{t("github.add")}</Text>
          <Pressable accessibilityRole="button" hitSlop={10} onPress={onClose}>
            <Text style={[styles.name, { color: colors.accent }]}>{t("common.close")}</Text>
          </Pressable>
        </View>
        <View>
          <View style={styles.searchIcon} pointerEvents="none">
            <Search size={15} color={colors.subtle} />
          </View>
          <Input value={filter} onChangeText={setFilter} placeholder={t("github.search")} accessibilityLabel={t("github.search")} style={{ paddingLeft: 36 }} />
        </View>
        {signIn ? (
          <View style={{ gap: 10 }}>
            <Notice>{t("github.reauthHint")}</Notice>
            <Button onPress={onSignIn}>{t("github.reauth")}</Button>
          </View>
        ) : (
          add.error && <Notice tone="bad">{errorMessage(add.error, t("common.error"))}</Notice>
        )}
        <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }}>
          {available.isPending ? (
            <View style={styles.center}>
              <Spinner />
            </View>
          ) : matches.length === 0 ? (
            !signIn && <Text style={[styles.sub, styles.center]}>{available.data?.length ? t("github.noMatch") : t("github.noneVisible")}</Text>
          ) : (
            matches.map((r) => (
              <Pressable
                key={r.id}
                accessibilityRole="button"
                disabled={add.isPending}
                onPress={() => add.mutate(r)}
                style={({ pressed }) => [styles.pick, pressed && { backgroundColor: colors.hover }, add.isPending && { opacity: 0.5 }]}
              >
                <FolderGit2 size={15} color={colors.muted} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {r.fullName}
                  </Text>
                  {r.description && (
                    <Text style={styles.sub} numberOfLines={1}>
                      {r.description}
                    </Text>
                  )}
                </View>
                {r.private && <Lock size={13} color={colors.subtle} accessibilityLabel={t("github.private")} />}
                {add.isPending && add.variables?.id === r.id ? <Spinner size={15} /> : <Plus size={15} color={colors.muted} />}
              </Pressable>
            ))
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    center: { alignItems: "center", paddingVertical: 16, textAlign: "center" },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
    name: { color: colors.fg, fontSize: 15 },
    sub: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
    meta: { flexDirection: "row", alignItems: "center", gap: 4 },
    link: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6 },
    sheet: { flex: 1, gap: 12, backgroundColor: colors.ground, padding: 16 },
    sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    sheetTitle: { color: colors.fg, fontSize: 17, fontWeight: "600" },
    searchIcon: { position: "absolute", left: 12, top: 0, bottom: 0, justifyContent: "center", zIndex: 1 },
    pick: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 10 },
  }),
);
