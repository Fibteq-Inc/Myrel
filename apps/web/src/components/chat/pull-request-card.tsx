import { foldPullRequests } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { PullRequest } from "@myrel/protocol";
import {
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LoaderCircle,
  MessageSquareWarning,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/ui";

/** The pull requests a message mentions by address. */
export function mentionedPullRequests(body: string, pullRequests: PullRequest[]): PullRequest[] {
  return pullRequests.filter((pr) => body.includes(pr.url));
}

/**
 * Pull requests a thread opened, each a card with its live state: open,
 * merged or closed, CI and review. The webhook keeps them current. In the
 * conversation a run of several folds the finished ones behind one line, so
 * they do not stack up under the last reply; `fold={false}` lists them all.
 * `wide`: fill the width (the PR tab), with the whole title and the branch.
 */
export function PullRequestCards({
  pullRequests,
  fold = true,
  wide = false,
}: {
  pullRequests: PullRequest[];
  fold?: boolean;
  wide?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (pullRequests.length === 0) return null;
  const { shown, folded } = fold ? foldPullRequests(pullRequests) : { shown: pullRequests, folded: [] };
  const merged = folded.filter((pr) => pr.state === "merged").length;
  const closed = folded.filter((pr) => pr.state === "closed").length;
  return (
    <div className="flex flex-col gap-2">
      {(open ? pullRequests : shown).map((pr) => (
        <PullRequestCard key={pr.url} pr={pr} wide={wide} />
      ))}
      {folded.length > 0 && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex max-w-md items-center gap-1.5 rounded-xl border border-dashed border-card px-3 py-2 text-left text-xs text-subtle transition-colors hover:border-edge hover:text-fg"
        >
          {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          {open ? (
            t("pr.showLess")
          ) : (
            <>
              <span className="font-medium text-muted">{t("pr.more", { count: folded.length })}</span>
              {merged > 0 && <span className="text-merged">· {t("pr.mergedCount", { count: merged })}</span>}
              {closed > 0 && <span className="text-bad">· {t("pr.closedCount", { count: closed })}</span>}
            </>
          )}
        </button>
      )}
    </div>
  );
}

function PullRequestCard({ pr, wide }: { pr: PullRequest; wide: boolean }) {
  const t = useT();
  const state =
    pr.state === "merged"
      ? { icon: GitMerge, label: t("pr.merged"), className: "text-merged" }
      : pr.state === "closed"
        ? { icon: GitPullRequestClosed, label: t("pr.closed"), className: "text-bad" }
        : pr.draft
          ? { icon: GitPullRequestDraft, label: t("pr.draft"), className: "text-subtle" }
          : { icon: GitPullRequest, label: t("pr.open"), className: "text-ok" };
  const StateIcon = state.icon;
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "group flex items-center gap-3 rounded-xl border border-card bg-raised px-3 py-2.5 text-fg hover:border-edge hover:bg-hover",
        !wide && "max-w-md",
      )}
    >
      <span className={cn("flex size-9 flex-none items-center justify-center rounded-lg border border-edge bg-panel", state.className)}>
        <StateIcon size={17} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[13.5px] font-semibold", wide ? "line-clamp-2" : "truncate")}>{pr.title}</span>
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-subtle">
          <span className="truncate">
            {pr.repo}#{pr.number}
          </span>
          <span className={state.className}>{state.label}</span>
          {wide && pr.branch && <span className="max-w-[16rem] truncate font-mono text-[11px]">{pr.branch}</span>}
          <Size pr={pr} />
          {pr.state === "open" && <Checks checks={pr.checks} />}
          {pr.state === "open" && pr.conflict && (
            <span className="flex items-center gap-1 text-bad">
              <TriangleAlert size={12} aria-hidden="true" />
              {t("pr.conflict")}
            </span>
          )}
          {pr.state === "open" && pr.review && (
            <span className={cn("flex items-center gap-1", pr.review === "approved" ? "text-ok" : "text-warn")}>
              {pr.review === "approved" ? (
                <CircleCheck size={12} aria-hidden="true" />
              ) : (
                <MessageSquareWarning size={12} aria-hidden="true" />
              )}
              {pr.review === "approved" ? t("pr.approved") : t("pr.changesRequested")}
            </span>
          )}
        </span>
      </span>
      <ExternalLink size={14} className="flex-none text-subtle group-hover:text-muted" aria-hidden="true" />
    </a>
  );
}

/** Lines added and removed, and how many files, once GitHub reported them. */
function Size({ pr }: { pr: PullRequest }) {
  const t = useT();
  if (pr.additions === null || pr.deletions === null) return null;
  return (
    <span className="flex items-center gap-1.5 tabular-nums" title={t("pr.size", { additions: pr.additions, deletions: pr.deletions })}>
      <span className="text-ok">+{pr.additions}</span>
      <span className="text-bad">−{pr.deletions}</span>
      {pr.changedFiles !== null && <span>· {t("pr.files", { count: pr.changedFiles })}</span>}
    </span>
  );
}

function Checks({ checks }: { checks: PullRequest["checks"] }) {
  const t = useT();
  if (checks === null) return null;
  if (checks === "pending") {
    return (
      <span className="flex items-center gap-1 text-warn">
        <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />
        {t("pr.checksPending")}
      </span>
    );
  }
  const ok = checks === "success";
  const Icon = ok ? CircleCheck : CircleX;
  return (
    <span className={cn("flex items-center gap-1", ok ? "text-ok" : "text-bad")}>
      <Icon size={12} aria-hidden="true" />
      {ok ? t("pr.checksSuccess") : t("pr.checksFailure")}
    </span>
  );
}
