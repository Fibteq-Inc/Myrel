import { draftKey, ISSUE_LIST_FRESHNESS } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { ProjectIssue, ProjectRepoIssues } from "@myrel/protocol";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { CircleDot, CircleCheck, ExternalLink, GitBranch, MessageSquare, SquarePen } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { drafts } from "../lib/drafts";
import { useProjectContext } from "../lib/project-context";
import { cn, errorMessage, useRelativeTime } from "../lib/ui";
import { Empty, ViewerBack } from "./artifacts";
import { OutsideMarkdown } from "./chat/markdown";
import { useProjectView } from "./project-view";
import { Segmented } from "./usage-dashboard";

type State = "open" | "closed" | "all";

/**
 * The Issues tab: the issues of the project's connected repositories, read live from GitHub, one
 * opened in place. Reading one here sends nothing to an agent: "Work on it" puts a request naming
 * the issue in the conversation's composer, and the thread's agent reads the issue itself, as data
 * (repo_read_issue).
 */
export function ProjectIssues() {
  const t = useT();
  const { project } = useProjectContext();
  const { search, go } = useProjectView();
  const [state, setState] = useState<State>("open");

  /** The request goes to the composer, after anything already typed there, for the person to send. */
  function workOn(issue: Pick<ProjectIssue, "repo" | "number" | "url">) {
    const key = draftKey(project.id);
    const ask = t("issues.workDraft", { ref: `${issue.repo}#${issue.number}`, url: issue.url });
    const typed = drafts.get(key).trim();
    drafts.set(key, typed ? `${typed}\n\n${ask}` : ask);
    go("chat");
  }

  const opened = parseIssueItem(search.item);
  if (opened) return <IssueView {...opened} key={search.item} onBack={() => go("issues")} onWork={workOn} />;
  return <IssueList state={state} onState={setState} onOpen={(i) => go("issues", { item: `${i.repo}#${i.number}` })} onWork={workOn} />;
}

/** The list, on its own so that coming back from an opened issue mounts it and asks GitHub again. */
function IssueList({ state, onState, onOpen, onWork }: { state: State; onState: (s: State) => void; onOpen: (i: ProjectIssue) => void; onWork: (i: ProjectIssue) => void }) {
  const t = useT();
  const { project } = useProjectContext();
  const issues = useQuery({
    queryKey: ["projects", project.id, "issues", state],
    queryFn: () => api.listProjectIssues(project.id, state),
    ...ISSUE_LIST_FRESHNESS,
  });
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
            onChange={onState}
          />
        </div>
        {issues.isPending ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-[10px] border border-line bg-raised" />
            ))}
          </div>
        ) : !issues.data ? (
          <p className="text-sm text-bad">{errorMessage(issues.error, t)}</p>
        ) : !repos.length ? (
          <Empty
            icon={<GitBranch size={20} className="text-subtle" aria-hidden="true" />}
            title={t("issues.noRepos")}
            body={t("issues.noReposBody")}
          />
        ) : (
          repos.map((r) => <RepoIssues key={r.repo} repo={r} state={state} onOpen={onOpen} onWork={onWork} />)
        )}
      </div>
    </div>
  );
}

/** An open issue in the URL, as owner/name#number. */
function parseIssueItem(item: string | undefined) {
  const match = item?.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  return match ? { repo: match[1]!, number: Number(match[2]) } : null;
}

/** One issue with its comments, in place of the list. Links stay inside what it shows (OutsideMarkdown). */
function IssueView({ repo, number, onBack, onWork }: { repo: string; number: number; onBack: () => void; onWork: (i: Pick<ProjectIssue, "repo" | "number" | "url">) => void }) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const { project } = useProjectContext();
  const query = useInfiniteQuery({
    queryKey: ["projects", project.id, "issue", repo, number],
    queryFn: ({ pageParam }) => api.getProjectIssue(project.id, repo, number, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last, _all, page) => (last.moreComments ? page + 1 : undefined),
    staleTime: 0,
  });
  const issue = query.data?.pages[0];
  const url = issue?.url ?? `https://github.com/${repo}/issues/${number}`;
  const comments = query.data?.pages.flatMap((p) => p.commentList) ?? [];
  const open = issue?.state === "open";
  const Icon = open ? CircleDot : CircleCheck;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-3 py-5 sm:px-5">
        <div className="flex items-center gap-2">
          <ViewerBack label={t("issues.back")} onClick={onBack} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-subtle">
            {repo}#{number}
          </span>
          <a href={url} target="_blank" rel="noreferrer" className="flex h-8 flex-none items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted hover:bg-hover hover:text-fg">
            <ExternalLink size={14} aria-hidden="true" />
            {t("issues.openOnGithub")}
          </a>
          {open && (
            <button type="button" onClick={() => onWork({ repo, number, url })} className="flex h-8 flex-none items-center gap-1.5 rounded-lg border border-card bg-field px-2.5 text-[13px] text-fg hover:bg-hover">
              <SquarePen size={14} aria-hidden="true" />
              <span className="max-sm:sr-only">{t("issues.work")}</span>
            </button>
          )}
        </div>
        {query.isPending ? (
          <div className="space-y-2" aria-busy="true">
            <div className="h-7 w-2/3 animate-pulse rounded-md bg-raised" />
            <div className="h-32 animate-pulse rounded-[10px] border border-line bg-raised" />
          </div>
        ) : !issue ? (
          <p className="text-sm text-bad">{t("issues.notFound")}</p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <h2 className="flex items-start gap-2 break-words text-lg font-semibold text-fg">
                <Icon size={17} className={cn("mt-1.5 flex-none", open ? "text-ok" : "text-subtle")} aria-label={t(open ? "issues.open" : "issues.closed")} />
                <span className="min-w-0">{issue.title}</span>
              </h2>
              {issue.labels.length > 0 && (
                <div className="flex flex-wrap gap-1 text-xs">
                  {issue.labels.map((l) => (
                    <span key={l} className="rounded-md bg-raised px-1.5 py-px text-muted">
                      {l}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <IssueText author={issue.author} member={issue.member} at={relativeTime(issue.createdAt)} dateTime={issue.createdAt} body={issue.body || t("issues.noBody")} />
            {issue.comments > 0 && (
              <section className="flex flex-col gap-3" aria-label={t("issues.commentCount", { count: issue.comments })}>
                <h3 className="text-xs font-medium text-subtle">{t("issues.commentCount", { count: issue.comments })}</h3>
                {comments.map((c, i) => (
                  <IssueText key={i} author={c.author} member={c.member} at={relativeTime(c.createdAt)} dateTime={c.createdAt} body={c.body} />
                ))}
                {query.isFetchNextPageError && <p className="text-[13px] text-bad">{t("issues.failed")}</p>}
                {query.hasNextPage && (
                  <button
                    type="button"
                    disabled={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                    className="h-8 self-start rounded-lg border border-card bg-field px-2.5 text-[13px] text-fg hover:bg-hover disabled:opacity-60"
                  >
                    {t("issues.moreComments")}
                  </button>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function IssueText({ author, member, at, dateTime, body }: { author: string; member: boolean; at: string; dateTime: string; body: string }) {
  const t = useT();
  return (
    <article className="overflow-hidden rounded-[10px] border border-line">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-raised px-3 py-2 text-xs text-subtle">
        <span className="font-medium text-muted">{author}</span>
        {!member && (
          <span className="rounded-md border border-line px-1.5 py-px" title={t("issues.outsideHint")}>
            {t("issues.outside")}
          </span>
        )}
        <time dateTime={dateTime}>{at}</time>
      </header>
      <div className="px-3 py-2.5">
        <OutsideMarkdown body={body} />
      </div>
    </article>
  );
}

function RepoIssues({ repo, state, onOpen, onWork }: { repo: ProjectRepoIssues; state: State; onOpen: (i: ProjectIssue) => void; onWork: (i: ProjectIssue) => void }) {
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
        repo.issues.map((i) => <IssueRow key={i.number} issue={i} onOpen={() => onOpen(i)} onWork={() => onWork(i)} />)
      )}
    </section>
  );
}

function IssueRow({ issue, onOpen, onWork }: { issue: ProjectIssue; onOpen: () => void; onWork: () => void }) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const open = issue.state === "open";
  const Icon = open ? CircleDot : CircleCheck;
  return (
    <div className="group flex items-start gap-3 rounded-[10px] px-2.5 py-2.5 hover:bg-hover">
      <Icon size={15} className={cn("mt-0.5 flex-none", open ? "text-ok" : "text-subtle")} aria-label={t(open ? "issues.open" : "issues.closed")} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <button type="button" onClick={onOpen} className={cn("break-words text-left hover:underline", open ? "font-medium text-fg" : "text-muted")}>
          {issue.title}
        </button>
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
