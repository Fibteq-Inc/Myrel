import type { MessageKey } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import type { ResearchSummary } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { api } from "../lib/api";
import { useFormat } from "../lib/format";
import { cn, useRelativeTime } from "../lib/ui";
import { useProjectView } from "./project-view";

const TONE: Record<ResearchSummary["status"], string> = {
  running: "text-accent",
  budget: "text-warn",
  done: "text-ok",
  failed: "text-bad",
};

/**
 * The threads tab's research view: every research by Claude the project's threads ran, newest
 * first, with its thread, state, spend against its budget and report, and this month's total.
 */
export function ProjectResearch({ projectId }: { projectId: string }) {
  const t = useT();
  const { cost } = useFormat();
  const usd = (cents: number) => cost(cents * 10_000);
  const { data: research = [], isPending } = useQuery({
    queryKey: ["projects", projectId, "research"],
    queryFn: () => api.listResearch(projectId),
    // A running one changes every minute or so; a finished list does not.
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === "running" || r.status === "budget") ? 30_000 : false),
  });
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = research.filter((r) => r.startedAt.startsWith(month));
  const total = thisMonth.reduce((sum, r) => sum + r.spentCents, 0);

  if (isPending) return null;
  if (research.length === 0) return <p className="px-2.5 py-2 text-[13px] text-subtle">{t("research.empty")}</p>;
  return (
    <section className="flex flex-col gap-1">
      <ul className="flex flex-col gap-0.5">
        {research.map((r) => (
          <li key={r.id}>
            <ResearchRow projectId={projectId} research={r} usd={usd} />
          </li>
        ))}
      </ul>
      {thisMonth.length > 0 && (
        <p className="px-2.5 pt-2 text-xs text-muted">{t("research.monthTotal", { count: thisMonth.length, amount: usd(total) })}</p>
      )}
    </section>
  );
}

function ResearchRow({ projectId, research: r, usd }: { projectId: string; research: ResearchSummary; usd: (cents: number) => string }) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const { go } = useProjectView();
  const status = r.status === "done" && r.partial ? t(`research.partial.${r.partial}` as MessageKey) : t(`research.status.${r.status}` as MessageKey);
  return (
    <div className="flex items-start gap-3 rounded-[10px] px-2.5 py-2.5 hover:bg-hover">
      <span className={cn("mt-1.5 size-2 flex-none rounded-full bg-current", r.partial ? "text-warn" : TONE[r.status])} aria-hidden="true" />
      <Link
        to="/projects/$projectId/threads/$threadId"
        params={{ projectId, threadId: r.threadId }}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-fg"
        activeProps={{ className: "bg-hover" }}
      >
        <span className="truncate font-medium">{r.title}</span>
        <span className="truncate text-xs text-subtle">
          <span className={cn(r.partial ? "text-warn" : TONE[r.status])}>{status}</span>
          {[r.threadTitle, r.approverName, relativeTime(r.startedAt)].filter(Boolean).map((part) => ` · ${part}`)}
        </span>
      </Link>
      <span className="flex flex-none flex-col items-end gap-0.5 text-xs">
        <span className="tabular-nums text-body">
          {usd(r.spentCents)} / {usd(r.budgetCents)}
        </span>
        {r.report ? (
          <button type="button" onClick={() => go("files", { item: r.report })} className="inline-flex items-center gap-1 text-link hover:underline">
            <FileText size={12} aria-hidden="true" />
            {t("research.report")}
          </button>
        ) : (
          r.status !== "failed" && <span className="text-subtle">{t("research.inProgress")}</span>
        )}
      </span>
    </div>
  );
}
