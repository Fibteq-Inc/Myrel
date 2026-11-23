import { messageUsage } from "@myrel/client";
import { useI18n, useT } from "@myrel/i18n/react";
import { type Message, planChecklist, threadWork, usageSpeed } from "@myrel/protocol";
import { ChartColumn, Clock, Coins, Gauge, LoaderCircle, Network } from "lucide-react";
import { useFormat } from "../../lib/format";
import { duration, harnessName, modelName } from "../chat/message-stats";
import { Card, speedText, Stat } from "../usage-dashboard";
import { EmptyTab } from "../workspace/workspace-panel";
import { useThreadStatsMessages } from "./use-thread-stats";

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
  const all = useThreadStatsMessages({ projectId, threadId, messages, complete, version });
  if (!all) {
    return (
      <div className="flex h-full min-h-60 items-center justify-center text-subtle">
        <LoaderCircle size={20} className="animate-spin" aria-label={t("chat.loading")} />
      </div>
    );
  }
  return <ThreadUsage messages={all} />;
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

  const { total, groups } = threadWork(replies);
  const tokens = total.inputTokens + total.outputTokens;
  const speed = usageSpeed(total);
  // A person's own CLI runs on their own account: it has no cost rather than none.
  const own = (u: { runtime: string; harness?: string | null }) => u.runtime === "local" && !!u.harness;
  const cost = (micros: number | null, free: boolean) => (free || micros === null ? "–" : fmt.cost(micros));
  const tok = (u: { inputTokens: number; outputTokens: number }) => u.inputTokens + u.outputTokens;

  return (
    <div className="space-y-4 p-4">
      <section aria-label={t("usage.totals")} className="grid grid-cols-2 gap-3">
        <Stat icon={<Network size={15} />} label={t("usage.tokens")} value={fmt.tokens(tokens)}>
          {t("usage.inOut", { input: fmt.tokens(total.inputTokens), output: fmt.tokens(total.outputTokens) })}
        </Stat>
        <Stat icon={<Coins size={15} />} label={t("usage.cost")} value={cost(total.costMicros, groups.every(own))}>
          {t("usage.listPrices")}
        </Stat>
        <Stat icon={<Clock size={15} />} label={t("threadUsage.time")} value={duration(total.durationMs, t, locale)}>
          {t("threadStats.turns", { count: total.turns })}
        </Stat>
        <Stat
          icon={<Gauge size={15} />}
          label={t(speed.model === null ? "usage.turnSpeed" : "usage.modelSpeed")}
          value={speedText(speed.model ?? speed.turn, fmt, t)}
          title={t("usage.speedHint")}
        >
          {speed.model === null ? t("usage.modelSpeedNone") : `${t("usage.turnSpeed")} ${speedText(speed.turn, fmt, t)}`}
        </Stat>
      </section>

      <Card title={t("usage.byModel")}>
        <ul className="divide-y divide-line text-[13px]">
          {groups.map((g) => {
            const share = tokens ? tok(g) / tokens : 0;
            const model = modelName(g.model);
            const label = model || (g.harness ? harnessName(g.harness) : t("stats.unpriced"));
            const speedOf = usageSpeed(g);
            const sub = [
              g.computer ?? t(g.runtime === "local" ? "stats.local" : "stats.cloud"),
              model && g.harness ? harnessName(g.harness) : null,
              `${t(speedOf.model === null ? "usage.turnSpeed" : "usage.modelSpeed")} ${speedText(speedOf.model ?? speedOf.turn, fmt, t)}`,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={g.key} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12px]" title={label}>
                    {label}
                  </span>
                  <span className="block truncate text-xs text-subtle" title={sub}>
                    {sub}
                  </span>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-hover" aria-hidden="true">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(share * 100, 1)}%` }} />
                  </div>
                </div>
                <span className="w-16 text-right tabular-nums text-muted">{fmt.tokens(tok(g))}</span>
                <span className="w-16 text-right tabular-nums">{cost(g.costMicros, own(g))}</span>
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
                <span className="w-16 text-right tabular-nums">{cost(u.costMicros, own(m.stats))}</span>
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
