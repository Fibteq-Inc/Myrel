import { messageUsage } from "@myrel/client";
import { useI18n } from "@myrel/i18n/react";
import { type Message, planChecklist } from "@myrel/protocol";
import { ChartColumn } from "lucide-react-native";
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { formatCost, formatDuration, formatTokens, modelName } from "../../lib/format";
import { makeStyles, mono, radius, useColors } from "../../theme";
import { harnessName } from "../message-stats";
import { Empty } from "../project/empty";
import { useRelativeTime } from "../ui";

type Usage = ReturnType<typeof messageUsage>;

const add = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  durationMs: a.durationMs + b.durationMs,
  costMicros: a.costMicros === null || b.costMicros === null ? null : a.costMicros + b.costMicros,
});
const ZERO: Usage = { inputTokens: 0, outputTokens: 0, durationMs: 0, costMicros: 0 };

/**
 * A thread's usage, from the stats lines under its agent's messages: totals, where it ran with which
 * harness and model, and each reply's share.
 */
export function ThreadUsageTab({ messages }: { messages: Message[] }) {
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

  const total = replies.reduce((sum, m) => add(sum, messageUsage(m.stats)), ZERO);
  const tok = (u: Usage) => u.inputTokens + u.outputTokens;
  const tokens = tok(total);
  const groups = new Map<string, { label: string; sub: string; usage: Usage }>();
  for (const m of replies) {
    const st = m.stats;
    const model = modelName(st.task?.model ?? st.model);
    const harness = st.task?.harness ?? st.harness;
    const key = `${st.runtime}/${st.computer ?? ""}/${harness ?? ""}/${model}`;
    const group = groups.get(key) ?? {
      label: model || (harness ? harnessName(harness) : t("stats.unpriced")),
      sub: [st.computer ?? t(st.runtime === "local" ? "stats.local" : "stats.cloud"), model && harness ? harnessName(harness) : null]
        .filter(Boolean)
        .join(" · "),
      usage: ZERO,
    };
    group.usage = add(group.usage, messageUsage(st));
    groups.set(key, group);
  }
  const cost = (u: Usage) => (u.costMicros === null ? "–" : formatCost(u.costMicros, locale));
  const fmt = (n: number) => formatTokens(n, locale);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.grid}>
        <Stat
          label={t("usage.tokens")}
          value={fmt(tokens)}
          hint={t("usage.inOut", { input: fmt(total.inputTokens), output: fmt(total.outputTokens) })}
        />
        <Stat label={t("usage.cost")} value={cost(total)} hint={t("usage.listPrices")} />
        <Stat
          label={t("threadUsage.time")}
          value={formatDuration(total.durationMs, t, locale)}
          hint={t("threadUsage.replies", { count: replies.length })}
        />
      </View>

      <Section title={t("usage.byModel")}>
        {[...groups.entries()].map(([key, g]) => {
          const share = tokens ? tok(g.usage) / tokens : 0;
          return (
            <View key={key} style={styles.line}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text style={[styles.lineName, { fontFamily: mono, fontSize: 12 }]} numberOfLines={1}>
                  {g.label}
                </Text>
                <Text style={styles.hint} numberOfLines={1}>
                  {g.sub}
                </Text>
                <View style={styles.bar}>
                  <View style={[styles.fill, { width: `${Math.max(share * 100, 1)}%` }]} />
                </View>
              </View>
              <Text style={styles.number}>{fmt(tok(g.usage))}</Text>
              <Text style={styles.value}>{cost(g.usage)}</Text>
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
              <Text style={styles.value}>{cost(u)}</Text>
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
