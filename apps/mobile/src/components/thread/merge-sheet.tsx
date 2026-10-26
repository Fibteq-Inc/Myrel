import { ApiError } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { MergeMethod, MergePullResult, PullMergeState, PullRequest } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, GitMerge } from "lucide-react-native";
import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../../lib/session";
import { makeStyles, radius, useColors } from "../../theme";
import { Button } from "../ui";

/**
 * Merge for a person who can merge into the repository on GitHub themselves; nobody else sees it.
 * While the pull request cannot be merged (CI, conflicts, review, branch rules) it says why.
 * The sheet is the person's go-ahead: merging cannot be undone from Myrel.
 */
export function MergeButton({ projectId, threadId, pr }: { projectId: string; threadId: string; pr: PullRequest }) {
  const colors = useColors();
  const styles = useStyles();
  const t = useT();
  const { api, server } = useSession();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["pullMerge", server, projectId, threadId, pr.repo, pr.number, pr.updatedAt],
    queryFn: () => api.pullRequestMergeState(projectId, threadId, pr.repo, pr.number),
    enabled: pr.state === "open",
  });
  if (pr.state !== "open" || !data?.permitted) return null;
  const blocked = data.blocked !== null;
  return (
    <View style={styles.row}>
      {data.blocked && <Text style={styles.reason}>{t(`pr.blocked.${data.blocked}`)}</Text>}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: blocked }}
        disabled={blocked}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.button, blocked && { opacity: 0.4 }, pressed && { opacity: 0.8 }]}
      >
        <GitMerge size={13} color={colors.ground} />
        <Text style={styles.buttonText}>{t("pr.merge")}</Text>
      </Pressable>
      {open && <MergeSheet projectId={projectId} threadId={threadId} pr={pr} state={data} onClose={() => setOpen(false)} />}
    </View>
  );
}

function MergeSheet({
  projectId,
  threadId,
  pr,
  state,
  onClose,
}: {
  projectId: string;
  threadId: string;
  pr: PullRequest;
  state: PullMergeState;
  onClose: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const t = useT();
  const insets = useSafeAreaInsets();
  const { api, server } = useSession();
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<MergeMethod>(state.methods.includes("merge") ? "merge" : state.methods[0]!);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [kept, setKept] = useState<MergePullResult["branchKept"]>(null);
  const merge = useMutation({
    mutationFn: () => api.mergePullRequest(projectId, threadId, pr.repo, pr.number, { method, sha: state.sha, deleteBranch }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["pullMerge", server, projectId, threadId, pr.repo, pr.number] });
      if (result.branchKept && deleteBranch) setKept(result.branchKept);
      else onClose();
    },
    onError: (err) => {
      // The branch moved: what the sheet showed is stale, so the tab looks again.
      if (err instanceof ApiError && err.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ["pullMerge", server, projectId, threadId, pr.repo, pr.number] });
        void queryClient.invalidateQueries({ queryKey: ["pullFiles", server, projectId, threadId, pr.repo, pr.number] });
      }
    },
  });
  const close = () => {
    if (!merge.isPending) onClose();
  };
  const error = merge.error;
  const headMoved = error instanceof ApiError && (error.body as { error?: string } | null)?.error === "head_moved";
  const files = pr.changedFiles !== null ? t("pr.files", { count: pr.changedFiles }) : "";

  return (
    <Modal visible transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} accessibilityLabel={t("common.close")} onPress={close} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
        <View style={{ gap: 4 }}>
          <Text style={styles.title}>{t("pr.mergeTitle", { number: pr.number })}</Text>
          <Text style={styles.body} numberOfLines={2}>
            {pr.title}
          </Text>
          <Text style={styles.hint}>
            {t("pr.mergeBody", { files, additions: pr.additions ?? 0, deletions: pr.deletions ?? 0, sha: state.sha.slice(0, 7) })}
          </Text>
        </View>
        {kept ? (
          <Text style={styles.body}>{t("pr.branchKept", { reason: t(`pr.kept.${kept}`) })}</Text>
        ) : (
          <>
            <View style={styles.methods}>
              {(["merge", "squash", "rebase"] as const).map((m) => {
                const allowed = state.methods.includes(m);
                const checked = method === m;
                return (
                  <Pressable
                    key={m}
                    accessibilityRole="radio"
                    accessibilityState={{ checked, disabled: !allowed }}
                    disabled={!allowed || merge.isPending}
                    onPress={() => setMethod(m)}
                    style={({ pressed }) => [
                      styles.option,
                      checked && { backgroundColor: colors.accentSoft },
                      !allowed && { opacity: 0.45 },
                      pressed && { backgroundColor: colors.hover },
                    ]}
                  >
                    <View style={[styles.mark, { borderRadius: 10 }, checked && styles.markOn]}>
                      {checked && <Check size={13} strokeWidth={3} color={colors.onAccent} />}
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.optionText}>{t(`pr.method.${m}`)}</Text>
                      <Text style={styles.hint}>{t(`pr.method.${m}Hint`)}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
            {!!pr.branch && (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: deleteBranch }}
                disabled={merge.isPending}
                onPress={() => setDeleteBranch(!deleteBranch)}
                style={styles.check}
              >
                <View style={[styles.mark, { borderRadius: 5 }, deleteBranch && styles.markOn]}>
                  {deleteBranch && <Check size={13} strokeWidth={3} color={colors.onAccent} />}
                </View>
                <Text style={[styles.body, { flex: 1 }]}>{t("pr.deleteBranch", { branch: pr.branch })}</Text>
              </Pressable>
            )}
            {error && (
              <Text accessibilityRole="alert" style={[styles.body, { color: colors.bad }]}>
                {headMoved ? t("pr.headMoved") : t("pr.mergeFailed", { message: error.message })}
              </Text>
            )}
          </>
        )}
        <View style={styles.actions}>
          {!kept && (
            <Button variant="ghost" onPress={close} disabled={merge.isPending} style={{ flex: 1 }}>
              {t("common.cancel")}
            </Button>
          )}
          <Button
            onPress={() => (kept ? onClose() : merge.mutate())}
            pending={merge.isPending}
            disabled={headMoved && !kept}
            style={{ flex: 1 }}
          >
            {kept ? t("common.close") : t("pr.merge")}
          </Button>
        </View>
      </View>
    </Modal>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
    reason: { color: colors.subtle, fontSize: 12, flexShrink: 1 },
    button: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      borderRadius: 8,
      backgroundColor: colors.merged,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    buttonText: { color: colors.ground, fontSize: 12, fontWeight: "600" },
    backdrop: { flex: 1, backgroundColor: colors.scrim },
    sheet: {
      gap: 14,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.edge,
      backgroundColor: colors.panel,
      paddingHorizontal: 16,
      paddingTop: 16,
    },
    title: { color: colors.fg, fontSize: 16, fontWeight: "600" },
    body: { color: colors.body, fontSize: 14, lineHeight: 20 },
    hint: { color: colors.subtle, fontSize: 12, lineHeight: 17 },
    methods: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, overflow: "hidden" },
    option: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    optionText: { color: colors.body, fontSize: 14, fontWeight: "500" },
    mark: { width: 20, height: 20, borderWidth: 1, borderColor: colors.edge, alignItems: "center", justifyContent: "center", marginTop: 1 },
    markOn: { borderColor: colors.accent, backgroundColor: colors.accent },
    check: { flexDirection: "row", alignItems: "center", gap: 12 },
    actions: { flexDirection: "row", gap: 10 },
  }),
);
