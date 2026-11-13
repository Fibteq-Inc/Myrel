import type { MessageKey } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import type { ResearchCard as Card, ResearchStatus } from "@myrel/protocol";
import { useMutation } from "@tanstack/react-query";
import { FileText, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useFormat } from "../../lib/format";
import { cn, errorMessage } from "../../lib/ui";
import { useProjectView } from "../project-view";

const TONE: Record<ResearchStatus, { text: string; bar: string }> = {
  running: { text: "text-accent", bar: "bg-accent" },
  budget: { text: "text-warn", bar: "bg-warn" },
  done: { text: "text-ok", bar: "bg-ok" },
  failed: { text: "text-bad", bar: "bg-bad" },
};

/** Whole minutes between two times, at least 1. */
function minutesBetween(from: string, to: number): number {
  return Math.max(1, Math.round((to - Date.parse(from)) / 60_000));
}

/** The time now, once a minute while `live`. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [live]);
  return now;
}

/** What a step shows: a page by its address without the scheme. */
function stepText(step: Card["steps"][number]): string {
  return step.kind === "read" ? step.text.replace(/^https?:\/\//, "").replace(/\/$/, "") : step.text;
}

/**
 * A research by Claude in its thread (start_research): what it spent against its budget, how many
 * searches and pages it took, its last steps while it runs, and at the end its short answer with
 * the report. Stop ends it with what it has written so far.
 */
export function ResearchCard({ card, projectId }: { card: Card; projectId: string }) {
  const t = useT();
  const { cost } = useFormat();
  const usd = (cents: number) => cost(cents * 10_000);
  const { go } = useProjectView();
  const tone = TONE[card.status];
  const live = card.status === "running";
  const now = useNow(live);
  const [confirming, setConfirming] = useState(false);
  const stop = useMutation({ mutationFn: () => api.researchAction(projectId, card.id, "stop"), onSuccess: () => setConfirming(false) });
  const share = Math.min(100, (card.spentCents / card.budgetCents) * 100);
  const minutes = minutesBetween(card.startedAt, card.endedAt ? Date.parse(card.endedAt) : now);
  const status =
    card.status === "done" && card.partial
      ? t(`research.partial.${card.partial}` as MessageKey)
      : t(`research.status.${card.status}` as MessageKey);
  const by = [card.approverName && t("research.approvedBy", { name: card.approverName }), card.stoppedBy && t("research.stoppedBy", { name: card.stoppedBy })]
    .filter(Boolean)
    .join(". ");

  return (
    <section className="rounded-xl border border-card bg-raised px-4 py-3.5 text-[13px]" aria-label={t("research.cardLabel", { title: card.title })}>
      <header className="flex items-center gap-2">
        <Search size={16} className="flex-none text-muted" aria-hidden="true" />
        <span className="min-w-0 truncate font-semibold text-fg">{card.title}</span>
        <span className={cn("ml-auto flex flex-none items-center gap-1.5 font-medium", card.partial ? "text-warn" : tone.text)}>
          <span className={cn("size-2 rounded-full bg-current", live && "motion-safe:animate-pulse")} aria-hidden="true" />
          {status}
        </span>
      </header>

      <div className="mt-3">
        <div className="mb-1.5 flex justify-between gap-3 text-xs text-subtle">
          <span>{t("research.spent")}</span>
          <span className="font-medium tabular-nums text-body">
            {usd(card.spentCents)} / {usd(card.budgetCents)}
          </span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-bubble"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={card.budgetCents}
          aria-valuenow={card.spentCents}
          aria-label={t("research.spent")}
        >
          <div className={cn("h-full rounded-full", card.partial ? "bg-warn" : tone.bar)} style={{ width: `${share}%` }} />
        </div>
      </div>

      <p className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span>{t("research.searches", { count: card.searches })}</span>
        <span>{t("research.pages", { count: card.pages })}</span>
        <span>{t("research.minutes", { count: minutes })}</span>
      </p>

      {live && card.steps.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-line border-t pt-2.5">
          {card.steps.map((step, i) => (
            <li key={`${step.kind}-${step.text}-${i}`} className="grid grid-cols-[56px_1fr] gap-2 text-[12.5px]">
              <span className="text-subtle">{t(`research.step.${step.kind}` as MessageKey)}</span>
              {step.kind === "read" ? (
                <a href={step.text} target="_blank" rel="noreferrer noopener" className="truncate text-link hover:underline">
                  {stepText(step)}
                </a>
              ) : (
                <span className="truncate text-body">{step.text}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {card.status === "budget" && <p className="mt-3 rounded-lg bg-bubble px-3 py-2 text-[12.5px] text-body">{t("research.waitingBudget")}</p>}
      {card.summary && <p className="mt-3 rounded-lg bg-bubble px-3 py-2 text-[12.5px] text-body">{card.summary}</p>}
      {card.note && card.status === "failed" && <p className="mt-3 text-xs text-bad">{card.note}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-subtle">
        {by && <span>{by}</span>}
        <span className="flex-1" />
        {card.report && (
          <button
            type="button"
            onClick={() => go("files", { item: card.report })}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-ground hover:bg-accent-hover"
          >
            <FileText size={14} aria-hidden="true" />
            {t("research.openReport")}
          </button>
        )}
        {(card.status === "running" || card.status === "budget") &&
          !card.stoppedBy &&
          (confirming ? (
            <>
              <span className="text-body">{t("research.stopHint")}</span>
              <button
                type="button"
                disabled={stop.isPending}
                onClick={() => stop.mutate()}
                className="rounded-lg border border-bad-line bg-bad-soft px-3 py-1.5 text-[13px] text-fg hover:bg-bad-hover disabled:opacity-60"
              >
                {t("research.stopSure")}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded-lg border border-edge bg-panel px-3 py-1.5 text-[13px] text-fg hover:bg-hover"
            >
              {t("research.stop")}
            </button>
          ))}
      </div>
      {stop.error && <p className="mt-2 text-xs text-bad">{errorMessage(stop.error, t)}</p>}
    </section>
  );
}
