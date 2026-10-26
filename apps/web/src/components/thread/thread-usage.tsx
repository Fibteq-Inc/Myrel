import { messageUsage } from "@myrel/client";
import { useI18n, useT } from "@myrel/i18n/react";
import { type Message, planChecklist } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { ChartColumn, Clock, Coins, LoaderCircle, Network } from "lucide-react";
import { api } from "../../lib/api";
import { useFormat } from "../../lib/format";
import { duration, harnessName, modelName } from "../chat/message-stats";
import { Card, Stat } from "../usage-dashboard";
import { EmptyTab } from "../workspace/workspace-panel";

type Usage = ReturnType<typeof messageUsage>;

const add = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  durationMs: a.durationMs + b.durationMs,
  costMicros: a.costMicros === null || b.costMicros === null ? null : a.costMicros + b.costMicros,
});
const ZERO: Usage = { inputTokens: 0, outputTokens: 0, durationMs: 0, costMicros: 0 };

/**
 * The usage tab of a thread: from the messages held when they are all here, otherwise from the
 * thread's replies with a stats line, fetched (again whenever the thread's summary moves).
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
  const t = useT();
  const fetched = useQuery({
    queryKey: ["projects", projectId, "threads", threadId, "usage", version],
    queryFn: () => api.threadUsageMessages(projectId, threadId),
    enabled: !complete,
  });
  if (complete) return <ThreadUsage messages={messages} />;
  if (!fetched.data) {
    return (
      <div className="flex h-full min-h-60 items-center justify-center text-subtle">
        <LoaderCircle size={20} className="animate-spin" aria-label={t("chat.loading")} />
      </div>
    );
  }
  return <ThreadUsage messages={fetched.data} />;
}

/**
 * A thread's usage, from the stats lines under its agent's messages: totals, where it ran with which
 * harness and model, and each reply's share.
 */
export function ThreadUsage({ messages }: { messages: Message[] }) {
  const t = useT();
  const fmt = useFormat();
  const { locale } = useI18n();
  const replies = messages.filter((m): m is Message & { stats: NonNullable<Message["stats"]> } => !!m.stats);
  if (replies.length === 0) {
    return (
      <EmptyTab icon={ChartColumn} title={t("threadUsage.empty")}>
        {t("threadUsage.emptyBody")}
      </EmptyTab>
    );
  }

  const total = replies.reduce((sum, m) => add(sum, messageUsage(m.stats)), ZERO);
  const tokens = total.inputTokens + total.outputTokens;
  const where = (local: boolean) => t(local ? "stats.local" : "stats.cloud");
  const groups = new Map<string, { label: string; sub: string; usage: Usage }>();
  for (const m of replies) {
    const st = m.stats;
    const model = modelName(st.task?.model ?? st.model);
    const harness = st.task?.harness ?? st.harness;
    const key = `${st.runtime}/${st.computer ?? ""}/${harness ?? ""}/${model}`;
    const group = groups.get(key) ?? {
      label: model || (harness ? harnessName(harness) : t("stats.unpriced")),
      sub: [st.computer ?? where(st.runtime === "local"), model && harness ? harnessName(harness) : null].filter(Boolean).join(" · "),
      usage: ZERO,
    };
    group.usage = add(group.usage, messageUsage(st));
    groups.set(key, group);
  }
  const cost = (u: Usage) => (u.costMicros === null ? "–" : fmt.cost(u.costMicros));
  const tok = (u: Usage) => u.inputTokens + u.outputTokens;

  return (
    <div className="space-y-4 p-4">
      <section aria-label={t("usage.totals")} className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        <Stat icon={<Network size={15} />} label={t("usage.tokens")} value={fmt.tokens(tokens)}>
          {t("usage.inOut", { input: fmt.tokens(total.inputTokens), output: fmt.tokens(total.outputTokens) })}
        </Stat>
        <Stat icon={<Coins size={15} />} label={t("usage.cost")} value={cost(total)}>
          {t("usage.listPrices")}
        </Stat>
        <Stat icon={<Clock size={15} />} label={t("threadUsage.time")} value={duration(total.durationMs, t, locale)}>
          {t("threadUsage.replies", { count: replies.length })}
        </Stat>
      </section>

      <Card title={t("usage.byModel")}>
        <ul className="divide-y divide-line text-[13px]">
          {[...groups.entries()].map(([key, g]) => {
            const share = tokens ? tok(g.usage) / tokens : 0;
            return (
              <li key={key} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12px]" title={g.label}>
                    {g.label}
                  </span>
                  <span className="block truncate text-xs text-subtle">{g.sub}</span>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-hover" aria-hidden="true">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(share * 100, 1)}%` }} />
                  </div>
                </div>
                <span className="w-16 text-right tabular-nums text-muted">{fmt.tokens(tok(g.usage))}</span>
                <span className="w-16 text-right tabular-nums">{cost(g.usage)}</span>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title={t("threadUsage.perReply")}>
        <ul className="divide-y divide-line text-[13px]">
          {[...replies].reverse().map((m) => {
            const u = messageUsage(m.stats);
            return (
              <li key={m.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="block truncate">{summary(m.body) || t("threadUsage.noText")}</span>
                  <span className="block truncate text-xs text-subtle">
                    {fmt.relative(m.createdAt)} · {duration(u.durationMs, t, locale)}
                  </span>
                </div>
                <span className="w-16 text-right tabular-nums text-muted">{fmt.tokens(tok(u))}</span>
                <span className="w-16 text-right tabular-nums">{cost(u)}</span>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
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
