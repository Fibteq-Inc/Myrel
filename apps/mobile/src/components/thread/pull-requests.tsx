import { useT } from "@myrel/i18n/react";
import type { PullRequest } from "@myrel/protocol";
import {
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
import type { ReactNode } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { makeStyles, mono, radius, useColors } from "../../theme";
import { Empty } from "../project/empty";
import { Spinner } from "../ui";

/** The pull requests a thread opened, each with its live state: open, merged or closed, CI and review. */
export function PullRequestsTab({ pullRequests }: { pullRequests: PullRequest[] }) {
  const colors = useColors();
  const styles = useStyles();
  const t = useT();
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
        <PullRequestCard key={pr.url} pr={pr} />
      ))}
    </ScrollView>
  );
}

function PullRequestCard({ pr }: { pr: PullRequest }) {
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
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${pr.title}, ${pr.repo}#${pr.number}, ${state.label}`}
      // The OS hands it to the GitHub app when it is installed, the browser otherwise.
      onPress={() => void Linking.openURL(pr.url).catch(() => {})}
      style={({ pressed }) => [styles.card, pressed && { backgroundColor: colors.hover }]}
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
      <ExternalLink size={14} color={colors.subtle} />
    </Pressable>
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
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.card,
      backgroundColor: colors.raised,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
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
