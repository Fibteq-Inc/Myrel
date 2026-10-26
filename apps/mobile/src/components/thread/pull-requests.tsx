import { useT } from "@myrel/i18n/react";
import { highlightLines } from "@myrel/client/highlight";
import type { PullFile, PullRequest } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquareWarning,
  TriangleAlert,
} from "lucide-react-native";
import { type ReactNode, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSession } from "../../lib/session";
import { makeStyles, mono, radius, useColors } from "../../theme";
import { CodeTokens } from "../code-view";
import { Empty } from "../project/empty";
import { Spinner } from "../ui";

/**
 * The pull requests a thread opened, each with its live state: open, merged or closed, CI and
 * review. Tapping one opens its changed files; tapping a file shows its diff.
 */
export function PullRequestsTab({ projectId, threadId, pullRequests }: { projectId: string; threadId: string; pullRequests: PullRequest[] }) {
  const colors = useColors();
  const styles = useStyles();
  const t = useT();
  const [picked, setPicked] = useState<string | null>(null);
  if (pullRequests.length === 0) {
    return (
      <Empty
        icon={<GitPullRequest size={22} color={colors.subtle} />}
        title={t("workspace.prEmpty")}
        body={t("workspace.prEmptyBody")}
      />
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.page}>
      {pullRequests.map((pr) => (
        <PullRequestCard
          key={pr.url}
          projectId={projectId}
          threadId={threadId}
          pr={pr}
          open={picked === pr.url}
          onToggle={() => setPicked(picked === pr.url ? null : pr.url)}
        />
      ))}
    </ScrollView>
  );
}

function PullRequestCard({
  projectId,
  threadId,
  pr,
  open: expanded,
  onToggle,
}: {
  projectId: string;
  threadId: string;
  pr: PullRequest;
  open: boolean;
  onToggle: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const t = useT();
  const state =
    pr.state === "merged"
      ? { Icon: GitMerge, label: t("pr.merged"), color: colors.merged }
      : pr.state === "closed"
        ? { Icon: GitPullRequestClosed, label: t("pr.closed"), color: colors.bad }
        : pr.draft
          ? { Icon: GitPullRequestDraft, label: t("pr.draft"), color: colors.subtle }
          : { Icon: GitPullRequest, label: t("pr.open"), color: colors.ok };
  const open = pr.state === "open";
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${pr.title}, ${pr.repo}#${pr.number}, ${state.label}`}
        onPress={onToggle}
        style={({ pressed }) => [styles.cardHead, pressed && { backgroundColor: colors.hover }]}
      >
        <View style={styles.icon}>
          <state.Icon size={17} color={state.color} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text style={styles.title} numberOfLines={2}>
            {pr.title}
          </Text>
          <View style={styles.meta}>
            <Text style={styles.metaText} numberOfLines={1}>
              {pr.repo}#{pr.number}
            </Text>
            <Text style={[styles.metaText, { color: state.color }]}>{state.label}</Text>
            {!!pr.branch && (
              <Text style={[styles.metaText, styles.branch]} numberOfLines={1}>
                {pr.branch}
              </Text>
            )}
            {pr.additions !== null && pr.deletions !== null && (
              <Text style={styles.metaText} accessibilityLabel={t("pr.size", { additions: pr.additions, deletions: pr.deletions })}>
                <Text style={{ color: colors.ok }}>+{pr.additions}</Text> <Text style={{ color: colors.bad }}>−{pr.deletions}</Text>
                {pr.changedFiles !== null && ` · ${t("pr.files", { count: pr.changedFiles })}`}
              </Text>
            )}
            {open && pr.checks === "pending" && (
              <Badge icon={<Spinner size={12} color={colors.warn} />} color={colors.warn} label={t("pr.checksPending")} />
            )}
            {open && pr.checks === "success" && (
              <Badge icon={<CircleCheck size={12} color={colors.ok} />} color={colors.ok} label={t("pr.checksSuccess")} />
            )}
            {open && pr.checks === "failure" && (
              <Badge icon={<CircleX size={12} color={colors.bad} />} color={colors.bad} label={t("pr.checksFailure")} />
            )}
            {open && pr.conflict && (
              <Badge icon={<TriangleAlert size={12} color={colors.bad} />} color={colors.bad} label={t("pr.conflict")} />
            )}
            {open && pr.review === "approved" && (
              <Badge icon={<CircleCheck size={12} color={colors.ok} />} color={colors.ok} label={t("pr.approved")} />
            )}
            {open && pr.review === "changes_requested" && (
              <Badge
                icon={<MessageSquareWarning size={12} color={colors.warn} />}
                color={colors.warn}
                label={t("pr.changesRequested")}
              />
            )}
          </View>
        </View>
        {expanded ? <ChevronDown size={15} color={colors.subtle} /> : <ChevronRight size={15} color={colors.subtle} />}
      </Pressable>
      {expanded && <PullRequestFiles projectId={projectId} threadId={threadId} pr={pr} />}
    </View>
  );
}

/** A pull request's changed files, a link to it on GitHub, and each file's diff on a tap. */
function PullRequestFiles({ projectId, threadId, pr }: { projectId: string; threadId: string; pr: PullRequest }) {
  const colors = useColors();
  const styles = useStyles();
  const t = useT();
  const { api, server } = useSession();
  // A new commit moves updatedAt; the server answers from its cache while the commit stays the same.
  const { data, isPending, error } = useQuery({
    queryKey: ["pullFiles", server, projectId, threadId, pr.repo, pr.number, pr.updatedAt],
    queryFn: () => api.pullRequestFiles(projectId, threadId, pr.repo, pr.number),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return (
    <View style={styles.detail}>
      {isPending ? (
        <Spinner size={16} color={colors.subtle} />
      ) : error ? (
        <Text style={[styles.metaText, { color: colors.bad }]}>{t("pr.filesFailed")}</Text>
      ) : (
        <View style={styles.files}>
          {data.files.map((file) => (
            <FileRow key={file.path} file={file} />
          ))}
        </View>
      )}
      {data?.truncated && <Text style={styles.metaText}>{t("pr.filesTruncated", { count: data.files.length })}</Text>}
      <Pressable
        accessibilityRole="link"
        // The OS hands it to the GitHub app when it is installed, the browser otherwise.
        onPress={() => void Linking.openURL(pr.url).catch(() => {})}
        style={({ pressed }) => [styles.github, pressed && { backgroundColor: colors.hover }]}
      >
        <Text style={styles.githubText}>{t("pr.openOnGithub")}</Text>
        <ExternalLink size={13} color={colors.fg} />
      </Pressable>
    </View>
  );
}

function FileRow({ file }: { file: PullFile }) {
  const colors = useColors();
  const styles = useStyles();
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.file}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={t("pr.showDiff", { path: file.path })}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.fileHead, pressed && { backgroundColor: colors.hover }]}
      >
        {open ? <ChevronDown size={13} color={colors.subtle} /> : <ChevronRight size={13} color={colors.subtle} />}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={[styles.path, file.status === "removed" && { color: colors.subtle, textDecorationLine: "line-through" }]}
            numberOfLines={1}
            ellipsizeMode="head"
          >
            {file.path}
          </Text>
          {file.previousPath && (
            <Text style={styles.metaText} numberOfLines={1} ellipsizeMode="head">
              {t("pr.renamedFrom", { path: file.previousPath })}
            </Text>
          )}
        </View>
        <Text style={[styles.count, { color: colors.ok }]}>+{file.additions}</Text>
        <Text style={[styles.count, { color: colors.bad }]}>−{file.deletions}</Text>
      </Pressable>
      {open && (file.patch ? <Patch patch={file.patch} /> : <Text style={[styles.metaText, styles.noPatch]}>{t("pr.noPatch")}</Text>)}
    </View>
  );
}

/** A file's diff hunks, colored like a diff; long lines scroll sideways. */
function Patch({ patch }: { patch: string }) {
  const colors = useColors();
  const styles = useStyles();
  const lines = useMemo(() => highlightLines(patch, "diff"), [patch]);
  return (
    <ScrollView horizontal style={styles.patch} contentContainerStyle={{ flexDirection: "column", minWidth: "100%" }}>
      {lines.map((line, i) => {
        const kind = line[0]?.kind;
        return (
          <Text
            key={i}
            style={[
              styles.patchLine,
              kind === "addition" && { backgroundColor: colors.okSoft },
              kind === "deletion" && { backgroundColor: colors.badSoft },
              kind === "meta" && { color: colors.subtle },
            ]}
          >
            <CodeTokens line={line} />
            {line.length === 0 && " "}
          </Text>
        );
      })}
    </ScrollView>
  );
}

function Badge({ icon, color, label }: { icon: ReactNode; color: string; label: string }) {
  const styles = useStyles();
  return (
    <View style={styles.badge}>
      {icon}
      <Text style={[styles.metaText, { color }]}>{label}</Text>
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    page: { padding: 16, gap: 8 },
    card: {
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.card,
      backgroundColor: colors.raised,
      overflow: "hidden",
    },
    cardHead: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 10 },
    detail: { borderTopWidth: 1, borderTopColor: colors.line, padding: 12, gap: 10 },
    files: { borderWidth: 1, borderColor: colors.line, borderRadius: 8, overflow: "hidden" },
    file: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
    fileHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
    path: { color: colors.body, fontFamily: mono, fontSize: 12 },
    count: { fontFamily: mono, fontSize: 12 },
    noPatch: { paddingHorizontal: 10, paddingBottom: 8 },
    patch: { backgroundColor: colors.panel, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    patchLine: { color: colors.body, fontFamily: mono, fontSize: 11.5, lineHeight: 17, paddingHorizontal: 10 },
    github: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-end",
      gap: 6,
      borderWidth: 1,
      borderColor: colors.edge,
      backgroundColor: colors.panel,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    githubText: { color: colors.fg, fontSize: 12 },
    icon: {
      width: 36,
      height: 36,
      borderRadius: 9,
      borderWidth: 1,
      borderColor: colors.edge,
      backgroundColor: colors.panel,
      alignItems: "center",
      justifyContent: "center",
    },
    title: { color: colors.fg, fontSize: 14, fontWeight: "600" },
    meta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 10, rowGap: 2 },
    metaText: { color: colors.subtle, fontSize: 12 },
    branch: { maxWidth: 200, fontFamily: mono },
    badge: { flexDirection: "row", alignItems: "center", gap: 4 },
  }),
);
