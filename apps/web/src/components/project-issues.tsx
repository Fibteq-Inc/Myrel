import { draftKey } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { ProjectIssue, ProjectRepoIssues } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { CircleDot, CircleCheck, ExternalLink, GitBranch, MessageSquare, SquarePen } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { drafts } from "../lib/drafts";
import { useProjectContext } from "../lib/project-context";
import { cn, errorMessage, useRelativeTime } from "../lib/ui";
import { Empty } from "./artifacts";
import { useProjectView } from "./project-view";
import { Segmented } from "./usage-dashboard";

type State = "open" | "closed" | "all";

/**
 * The Issues tab: the issues of the project's connected repositories, read live from GitHub. Their
 * text stays there: "Work on it" puts a request naming the issue in the conversation's composer,
 * and the thread's agent reads the issue itself, as data (repo_read_issue).
 */
export function ProjectIssues() {
  const t = useT();
  const { project } = useProjectContext();
  const { go } = useProjectView();
  const [state, setState] = useState<State>("open");
  const issues = useQuery({
    queryKey: ["projects", project.id, "issues", state],
    queryFn: () => api.listProjectIssues(project.id, state),
    staleTime: 60_000,
  });

  /** The request goes to the composer, after anything already typed there, for the person to send. */
  function workOn(issue: ProjectIssue) {
    const key = draftKey(project.id);
    const ask = t("issues.workDraft", { ref: `${issue.repo}#${issue.number}`, url: issue.url });
    const typed = drafts.get(key).trim();
    drafts.set(key, typed ? `${typed}\n\n${ask}` : ask);
    go("chat");
  }

  const repos = issues.data ?? [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-3 py-6 sm:px-5">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-[13px] text-subtle">{t("issues.intro")}</p>
          <Segmented
            label={t("issues.show")}
            value={state}
            options={(["open", "closed", "all"] as const).map((s) => ({ value: s, label: t(`issues.${s}`) }))}
            onChange={setState}
          />
        </div>
        {issues.isPending ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-[10px] border border-line bg-raised" />
            ))}
          </div>
        ) : issues.error ? (
          <p className="text-sm text-bad">{errorMessage(issues.error, t)}</p>
        ) : !repos.length ? (
          <Empty
            icon={<GitBranch size={20} className="text-subtle" aria-hidden="true" />}
            title={t("issues.noRepos")}
            body={t("issues.noReposBody")}
          />
        ) : (
          repos.map((r) => <RepoIssues key={r.repo} repo={r} state={state} onWork={workOn} />)
        )}
      </div>
    </div>
  );
}

function RepoIssues({ repo, state, onWork }: { repo: ProjectRepoIssues; state: State; onWork: (i: ProjectIssue) => void }) {
  const t = useT();
  return (
    <section className="flex flex-col gap-1">
      <h2 className="flex items-center px-2.5 pb-1 text-xs font-medium text-subtle">
        {repo.repo}
        {!repo.error && <span className="ml-auto font-mono">{repo.issues.length}</span>}
      </h2>
      {repo.error ? (
        <p className="px-2.5 text-[13px] text-subtle">{t(repo.error === "no_access" ? "issues.noAccess" : "issues.failed")}</p>
      ) : !repo.issues.length ? (
        <p className="px-2.5 text-[13px] text-subtle">{t(state === "closed" ? "issues.emptyClosed" : "issues.empty")}</p>
      ) : (
        repo.issues.map((i) => <IssueRow key={i.number} issue={i} onWork={() => onWork(i)} />)
      )}
    </section>
  );
}

function IssueRow({ issue, onWork }: { issue: ProjectIssue; onWork: () => void }) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const open = issue.state === "open";
  const Icon = open ? CircleDot : CircleCheck;
  return (
    <div className="group flex items-start gap-3 rounded-[10px] px-2.5 py-2.5 hover:bg-hover">
      <Icon size={15} className={cn("mt-0.5 flex-none", open ? "text-ok" : "text-subtle")} aria-label={t(open ? "issues.open" : "issues.closed")} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <a href={issue.url} target="_blank" rel="noreferrer" className={cn("break-words hover:underline", open ? "font-medium text-fg" : "text-muted")}>
          {issue.title}
        </a>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
          <span className="font-mono">#{issue.number}</span>
          <span>{issue.author}</span>
          {!issue.member && (
            <span className="rounded-md border border-line px-1.5 py-px" title={t("issues.outsideHint")}>
              {t("issues.outside")}
            </span>
          )}
          {issue.labels.map((l) => (
            <span key={l} className="rounded-md bg-raised px-1.5 py-px text-muted">
              {l}
            </span>
          ))}
          {issue.comments > 0 && (
            <span className="flex items-center gap-1">
              <MessageSquare size={12} aria-hidden="true" />
              {issue.comments}
            </span>
          )}
          <time dateTime={issue.updatedAt}>{relativeTime(issue.updatedAt)}</time>
        </div>
      </div>
      <div className="flex flex-none items-center gap-1">
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          aria-label={t("issues.openOnGithub")}
          title={t("issues.openOnGithub")}
          className="flex size-8 items-center justify-center rounded-lg text-subtle hover:bg-raised hover:text-fg"
        >
          <ExternalLink size={15} aria-hidden="true" />
        </a>
        {open && (
          <button
            type="button"
            onClick={onWork}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-card bg-field px-2.5 text-[13px] text-fg hover:bg-hover"
          >
            <SquarePen size={14} aria-hidden="true" />
            <span className="max-sm:sr-only">{t("issues.work")}</span>
          </button>
        )}
      </div>
    </div>
  );
}
