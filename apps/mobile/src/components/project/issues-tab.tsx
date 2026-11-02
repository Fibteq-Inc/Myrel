import { useT } from "@myrel/i18n/react";
import type { ProjectIssue } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleDot, ExternalLink, GitBranch, MessageSquare, SquarePen } from "lucide-react-native";
import { useState } from "react";
import { Linking, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { useProjectId } from "../../lib/project";
import { useSession } from "../../lib/session";
import { makeStyles, mono, radius, useColors } from "../../theme";
import { errorMessage, Spinner, useRelativeTime } from "../ui";
import { Empty } from "./empty";

type State = "open" | "closed" | "all";

/**
 * The issues of the project's connected repositories, live from GitHub, as on the web. "Work on it"
 * hands a request naming the issue to the conversation's composer (`onWork`); the issue's text stays
 * on GitHub, and the thread's agent reads it as data.
 */
export function IssuesTab({ onWork }: { onWork: (issue: ProjectIssue) => void }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const { api, server } = useSession();
  const projectId = useProjectId();
  const [state, setState] = useState<State>("open");
  const issues = useQuery({
    queryKey: ["issues", server, projectId, state],
    queryFn: () => api.listProjectIssues(projectId, state),
    staleTime: 60_000,
  });

  if (issues.isPending) {
    return (
      <View style={styles.center}>
        <Spinner size={22} color={colors.subtle} />
      </View>
    );
  }
  if (issues.error) return <Empty title={errorMessage(issues.error, t("common.error"))} />;

  const sections = issues.data.map((r) => ({
    title: r.repo,
    note: r.error ? t(r.error === "no_access" ? "issues.noAccess" : "issues.failed") : r.issues.length ? null : t(state === "closed" ? "issues.emptyClosed" : "issues.empty"),
    data: r.issues,
  }));
  return (
    <SectionList
      sections={sections}
      keyExtractor={(i) => `${i.repo}#${i.number}`}
      contentContainerStyle={styles.list}
      stickySectionHeadersEnabled={false}
      refreshControl={<RefreshControl refreshing={issues.isRefetching} onRefresh={() => void issues.refetch()} tintColor={colors.subtle} />}
      ListHeaderComponent={
        <View style={{ gap: 10 }}>
          <Text style={styles.intro}>{t("issues.intro")}</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel={t("issues.show")} style={styles.segments}>
            {(["open", "closed", "all"] as const).map((s) => (
              <Pressable
                key={s}
                accessibilityRole="radio"
                accessibilityState={{ checked: s === state }}
                onPress={() => setState(s)}
                style={[styles.segment, s === state && styles.segmentOn]}
              >
                <Text style={[styles.segmentText, s === state && { color: colors.fg }]}>{t(`issues.${s}`)}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      }
      ListEmptyComponent={<Empty icon={<GitBranch size={22} color={colors.subtle} />} title={t("issues.noRepos")} body={t("issues.noReposBody")} />}
      renderSectionHeader={({ section }) => (
        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          {section.note && <Text style={styles.meta}>{section.note}</Text>}
        </View>
      )}
      renderItem={({ item }) => <IssueRow issue={item} onWork={() => onWork(item)} />}
    />
  );
}

function IssueRow({ issue, onWork }: { issue: ProjectIssue; onWork: () => void }) {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const relativeTime = useRelativeTime();
  const open = issue.state === "open";
  const Icon = open ? CircleDot : CircleCheck;
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="link"
        accessibilityHint={t("issues.openOnGithub")}
        onPress={() => void Linking.openURL(issue.url).catch(() => {})}
        style={({ pressed }) => [styles.main, pressed && { opacity: 0.6 }]}
      >
        <Icon size={16} color={open ? colors.ok : colors.subtle} style={{ marginTop: 2 }} />
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text style={[styles.title, !open && { color: colors.muted, fontWeight: "400" }]}>{issue.title}</Text>
          <View style={styles.metaRow}>
            <Text style={[styles.meta, { fontFamily: mono }]}>#{issue.number}</Text>
            <Text style={styles.meta}>{issue.author}</Text>
            {!issue.member && <Text style={styles.chip}>{t("issues.outside")}</Text>}
            {issue.labels.map((l) => (
              <Text key={l} style={styles.chip}>
                {l}
              </Text>
            ))}
            {issue.comments > 0 && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                <MessageSquare size={11} color={colors.subtle} />
                <Text style={styles.meta}>{issue.comments}</Text>
              </View>
            )}
            <Text style={styles.meta}>{relativeTime(issue.updatedAt)}</Text>
          </View>
        </View>
        <ExternalLink size={14} color={colors.subtle} style={{ marginTop: 2 }} />
      </Pressable>
      {open && (
        <Pressable accessibilityRole="button" onPress={onWork} style={({ pressed }) => [styles.work, pressed && { backgroundColor: colors.hover }]}>
          <SquarePen size={14} color={colors.fg} />
          <Text style={styles.workText}>{t("issues.work")}</Text>
        </Pressable>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    list: { padding: 16, gap: 8, flexGrow: 1 },
    intro: { color: colors.subtle, fontSize: 13 },
    segments: { flexDirection: "row", alignSelf: "flex-start", borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, padding: 2 },
    segment: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.sm },
    segmentOn: { backgroundColor: colors.hover },
    segmentText: { color: colors.muted, fontSize: 13 },
    sectionHead: { paddingTop: 14, paddingBottom: 4, gap: 4 },
    sectionTitle: { color: colors.subtle, fontSize: 12, fontWeight: "500" },
    row: { gap: 10, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.raised, marginBottom: 8 },
    main: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
    title: { color: colors.fg, fontSize: 14, fontWeight: "500" },
    metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
    meta: { color: colors.subtle, fontSize: 12 },
    chip: { color: colors.muted, fontSize: 11, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: 5, overflow: "hidden" },
    work: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, marginLeft: 26 },
    workText: { color: colors.fg, fontSize: 13 },
  }),
);
