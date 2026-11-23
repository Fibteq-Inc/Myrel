import { messageUsage } from "@myrel/client";
import { useI18n } from "@myrel/i18n/react";
import { type Message, planChecklist, threadWork, usageSpeed } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { ChartColumn } from "lucide-react-native";
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { formatCost, formatDuration, formatSpeed, formatTokens, modelName } from "../../lib/format";
import { makeStyles, mono, radius, useColors } from "../../theme";
import { harnessName } from "../message-stats";
import { Empty } from "../project/empty";
import { useSession } from "../../lib/session";
import { Spinner, useRelativeTime } from "../ui";

/**
 * The messages a thread's statistics are added up from: the ones held when they are all here, otherwise
 * the thread's replies with a stats line, fetched (again whenever the thread's usage moves) while
 * `enabled`. Null until they are here.
 */
export function useThreadStatsMessages({
  projectId,
  threadId,
  messages,
  complete,
  version,
  enabled = true,
}: {
  projectId: string;
  threadId: string;
  messages: Message[];
  /** Every message of the thread is held. */
  complete: boolean;
  /** Changes when the thread's usage does. */
  version: string;
  enabled?: boolean;
}): Message[] | null {
  const { api, server } = useSession();
  const fetched = useQuery({
    queryKey: ["threadUsage", server, projectId, threadId, version],
    queryFn: () => api.threadUsageMessages(projectId, threadId),
    enabled: enabled && !complete,
  });
  return complete ? messages : (fetched.data ?? null);
}

/**
 * A thread's usage from the messages held when they are all here, otherwise from the thread's replies
 * with a stats line, fetched (again whenever the thread's summary moves).
 */
export function ThreadUsageTab({
  projectId,
  threadId,
  messages,
  complete,
  version,
}: {
  projectId: string;
  threadId: string;
  messages: Message[];
  /** Every message of the thread is held. */
  complete: boolean;
  /** Changes when the thread's usage does. */
  version: string;
}) {
  const all = useThreadStatsMessages({ projectId, threadId, messages, complete, version });
  if (!all) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Spinner size={20} />
      </View>
    );
  }
  return <ThreadUsage messages={all} />;
}

/**
 * A thread's usage, from the stats lines under its agent's messages: totals, where it ran with which
 * harness and model, and each reply's share.
 */
function ThreadUsage({ messages }: { messages: Message[] }) {
  const colors = useColors();
  const styles = useStyles();
  const { t, locale } = useI18n();
  const relativeTime = useRelativeTime();
  const replies = messages.filter((m): m is Message & { stats: NonNullable<Message["stats"]> } => !!m.stats);
  if (replies.length === 0) {
    return (
      <Empty
        icon={<ChartColumn size={22} color={colors.subtle} />}
        title={t("threadUsage.empty")}
        body={t("threadUsage.emptyBody")}
      />
    );
  }

  const { total, groups } = threadWork(replies);
  const tok = (u: { inputTokens: number; outputTokens: number }) => u.inputTokens + u.outputTokens;
  const tokens = tok(total);
  const speed = usageSpeed(total);
  // A person's own CLI runs on their own account: it has no cost rather than none.
  const own = (u: { runtime: string; harness?: string | null }) => u.runtime === "local" && !!u.harness;
  const cost = (micros: number | null, free: boolean) => (free || micros === null ? "–" : formatCost(micros, locale));
  const fmt = (n: number) => formatTokens(n, locale);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.grid}>
        <Stat
          label={t("usage.tokens")}
          value={fmt(tokens)}
          hint={t("usage.inOut", { input: fmt(total.inputTokens), output: fmt(total.outputTokens) })}
        />
        <Stat label={t("usage.cost")} value={cost(total.costMicros, groups.every(own))} hint={t("usage.listPrices")} />
        <Stat
          label={t("threadUsage.time")}
          value={formatDuration(total.durationMs, t, locale)}
          hint={t("threadStats.turns", { count: total.turns })}
        />
        <Stat
          label={t(speed.model === null ? "usage.turnSpeed" : "usage.modelSpeed")}
          value={formatSpeed(speed.model ?? speed.turn, t, locale)}
          hint={speed.model === null ? t("usage.modelSpeedNone") : `${t("usage.turnSpeed")} ${formatSpeed(speed.turn, t, locale)}`}
        />
      </View>

      <Section title={t("usage.byModel")}>
        {groups.map((g) => {
          const share = tokens ? tok(g) / tokens : 0;
          const model = modelName(g.model);
          const speedOf = usageSpeed(g);
          return (
            <View key={g.key} style={styles.line}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text style={[styles.lineName, { fontFamily: mono, fontSize: 12 }]} numberOfLines={1}>
                  {model || (g.harness ? harnessName(g.harness) : t("stats.unpriced"))}
                </Text>
                <Text style={styles.hint} numberOfLines={1}>
                  {[g.computer ?? t(g.runtime === "local" ? "stats.local" : "stats.cloud"), model && g.harness ? harnessName(g.harness) : null].filter(Boolean).join(" · ")}
                </Text>
                <Text style={styles.hint} numberOfLines={1}>
                  {t(speedOf.model === null ? "usage.turnSpeed" : "usage.modelSpeed")} {formatSpeed(speedOf.model ?? speedOf.turn, t, locale)}
                </Text>
                <View style={styles.bar}>
                  <View style={[styles.fill, { width: `${Math.max(share * 100, 1)}%` }]} />
                </View>
              </View>
              <Text style={styles.number}>{fmt(tok(g))}</Text>
              <Text style={styles.value}>{cost(g.costMicros, own(g))}</Text>
            </View>
          );
        })}
      </Section>

      <Section title={t("threadUsage.perReply")}>
        {[...replies].reverse().map((m) => {
          const u = messageUsage(m.stats);
          return (
            <View key={m.id} style={styles.line}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text style={styles.lineName} numberOfLines={1}>
                  {summary(m.body) || t("threadUsage.noText")}
                </Text>
                <Text style={styles.hint} numberOfLines={1}>
                  {relativeTime(m.createdAt)} · {formatDuration(u.durationMs, t, locale)}
                </Text>
              </View>
              <Text style={styles.number}>{fmt(tok(u))}</Text>
              <Text style={styles.value}>{cost(u.costMicros, own(m.stats))}</Text>
            </View>
          );
        })}
      </Section>
    </ScrollView>
  );
}

/** A message's first line of prose, for the list; plan cards show their title. */
function summary(body: string): string {
  const plan = planChecklist(body);
  const text = plan ? plan.split("\n")[0]! : body;
  return (
    text
      .split("\n")
      .map((l) => l.replace(/^[#>*\-\s`]+/, "").trim())
      .find(Boolean) ?? ""
  ).slice(0, 160);
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  const styles = useStyles();
  return (
    <View style={styles.stat}>
      <Text style={styles.hint}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.hint}>{hint}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.section}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    page: { padding: 16, gap: 20 },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    stat: {
      flexGrow: 1,
      flexBasis: "45%",
      gap: 4,
      padding: 14,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.raised,
    },
    statValue: { color: colors.fg, fontSize: 20, fontWeight: "600" },
    hint: { color: colors.subtle, fontSize: 12 },
    section: { color: colors.subtle, fontSize: 13, fontWeight: "600" },
    card: {
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.raised,
      paddingHorizontal: 14,
    },
    line: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    lineName: { color: colors.fg, fontSize: 14 },
    bar: { marginTop: 4, height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: colors.hover },
    fill: { height: "100%", borderRadius: 2, backgroundColor: colors.accent },
    number: { width: 52, textAlign: "right", color: colors.muted, fontSize: 13, fontVariant: ["tabular-nums"] },
    value: { width: 56, textAlign: "right", color: colors.body, fontSize: 13, fontVariant: ["tabular-nums"] },
  }),
);
