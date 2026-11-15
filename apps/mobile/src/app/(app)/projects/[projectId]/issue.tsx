import { useT } from "@myrel/i18n/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { CircleCheck, CircleDot, ExternalLink } from "lucide-react-native";
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { OutsideMarkdown } from "../../../../components/markdown";
import { Empty } from "../../../../components/project/empty";
import { Button, Spinner, useRelativeTime } from "../../../../components/ui";
import { useProjectId } from "../../../../lib/project";
import { useSession } from "../../../../lib/session";
import { makeStyles, mono, radius, useColors } from "../../../../theme";

/** One issue with its comments, as on the web's Issues tab. Reading it here sends nothing to an agent. */
export default function IssueScreen() {
  const t = useT();
  const colors = useColors();
  const styles = useStyles();
  const relativeTime = useRelativeTime();
  const params = useLocalSearchParams<{ repo: string; number: string }>();
  const number = Number(params.number);
  const { api, server } = useSession();
  const projectId = useProjectId();
  const query = useInfiniteQuery({
    queryKey: ["issue", server, projectId, params.repo, number],
    queryFn: ({ pageParam }) => api.getProjectIssue(projectId, params.repo, number, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last, _all, page) => (last.moreComments ? page + 1 : undefined),
    staleTime: 0,
  });
  const issue = query.data?.pages[0];
  const url = issue?.url ?? `https://github.com/${params.repo}/issues/${number}`;
  const comments = query.data?.pages.flatMap((p) => p.commentList) ?? [];
  const open = issue?.state === "open";
  const Icon = open ? CircleDot : CircleCheck;
  const openOnGithub = () => void Linking.openURL(url).catch(() => {});
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: `#${number}`,
          headerRight: () => (
            <Pressable accessibilityRole="link" accessibilityLabel={t("issues.openOnGithub")} hitSlop={10} onPress={openOnGithub}>
              <ExternalLink size={20} color={colors.fg} />
            </Pressable>
          ),
        }}
      />
      {query.isPending ? (
        <View style={styles.center}>
          <Spinner size={22} color={colors.subtle} />
        </View>
      ) : !issue ? (
        <Empty title={t("issues.notFound")} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.page}
          refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} tintColor={colors.subtle} />}
        >
          <Text style={styles.repo}>
            {issue.repo}#{issue.number}
          </Text>
          <View style={styles.titleRow}>
            <Icon size={18} color={open ? colors.ok : colors.subtle} style={{ marginTop: 3 }} accessibilityLabel={t(open ? "issues.open" : "issues.closed")} />
            <Text selectable style={styles.title}>
              {issue.title}
            </Text>
          </View>
          {issue.labels.length > 0 && (
            <View style={styles.labels}>
              {issue.labels.map((l) => (
                <Text key={l} style={styles.chip}>
                  {l}
                </Text>
              ))}
            </View>
          )}
          <IssueText author={issue.author} member={issue.member} at={relativeTime(issue.createdAt)} body={issue.body || t("issues.noBody")} />
          {issue.comments > 0 && <Text style={styles.heading}>{t("issues.commentCount", { count: issue.comments })}</Text>}
          {comments.map((c, i) => (
            <IssueText key={i} author={c.author} member={c.member} at={relativeTime(c.createdAt)} body={c.body} />
          ))}
          {query.isFetchNextPageError && <Text style={styles.failed}>{t("issues.failed")}</Text>}
          {query.hasNextPage && (
            <Button variant="ghost" pending={query.isFetchingNextPage} onPress={() => void query.fetchNextPage()}>
              {t("issues.moreComments")}
            </Button>
          )}
        </ScrollView>
      )}
    </View>
  );
}

function IssueText({ author, member, at, body }: { author: string; member: boolean; at: string; body: string }) {
  const t = useT();
  const styles = useStyles();
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.author}>{author}</Text>
        {!member && <Text style={styles.chip}>{t("issues.outside")}</Text>}
        <Text style={styles.meta}>{at}</Text>
      </View>
      <View style={styles.cardBody}>
        <OutsideMarkdown body={body} />
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    page: { padding: 16, gap: 12 },
    repo: { color: colors.subtle, fontFamily: mono, fontSize: 12 },
    titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    title: { flex: 1, minWidth: 0, color: colors.fg, fontSize: 18, fontWeight: "600" },
    labels: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    chip: { color: colors.muted, fontSize: 11, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, paddingHorizontal: 5, overflow: "hidden" },
    heading: { color: colors.subtle, fontSize: 12, fontWeight: "500", marginTop: 4 },
    failed: { color: colors.bad, fontSize: 13 },
    card: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, overflow: "hidden" },
    cardHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.raised, borderBottomWidth: 1, borderBottomColor: colors.line },
    cardBody: { paddingHorizontal: 12, paddingTop: 10 },
    author: { color: colors.muted, fontSize: 12, fontWeight: "500" },
    meta: { color: colors.subtle, fontSize: 12 },
  }),
);
