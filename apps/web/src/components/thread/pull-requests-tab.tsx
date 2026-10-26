import { useT } from "@myrel/i18n/react";
import type { PullFile, PullRequest } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ExternalLink, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { PullRequestMeta, usePullRequestState } from "../chat/pull-request-card";
import { api } from "../../lib/api";
import { CodeTokens, lineClass, useCodeLines } from "../../lib/highlight";
import { cn } from "../../lib/ui";

/**
 * The thread's pull requests and what each changes. On a wide panel the list
 * sits on the left and the picked one's files and diffs on the right; on a
 * narrow one the picked row opens in place.
 */
export function PullRequestsTab({
  projectId,
  threadId,
  pullRequests,
}: {
  projectId: string;
  threadId: string;
  pullRequests: PullRequest[];
}) {
  const t = useT();
  // The newest open one is picked first, else the newest.
  const first = [...pullRequests].reverse().find((pr) => pr.state === "open") ?? pullRequests.at(-1);
  const [picked, setPicked] = useState<string | null>(first?.url ?? null);
  const current = pullRequests.find((pr) => pr.url === picked);
  return (
    <div className="@container h-full">
      <div className="grid min-h-full @[720px]:h-full @[720px]:grid-cols-[minmax(260px,2fr)_3fr]">
        <ul className="flex min-w-0 flex-col gap-2 p-4 @[720px]:overflow-y-auto">
          {pullRequests.map((pr) => {
            const open = pr.url === picked;
            return (
              <li key={pr.url} className={cn("overflow-hidden rounded-xl border bg-raised", open ? "border-edge @[720px]:border-accent" : "border-card")}>
                <PullRequestRow pr={pr} open={open} onClick={() => setPicked(open ? null : pr.url)} />
                {open && (
                  <div className="border-t border-line @[720px]:hidden">
                    <PullRequestDetail projectId={projectId} threadId={threadId} pr={pr} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <section className="hidden min-w-0 border-l border-line @[720px]:block @[720px]:overflow-y-auto">
          {current ? (
            <PullRequestDetail projectId={projectId} threadId={threadId} pr={current} header />
          ) : (
            <p className="p-8 text-center text-[13px] text-subtle">{t("pr.pick")}</p>
          )}
        </section>
      </div>
    </div>
  );
}

function PullRequestRow({ pr, open, onClick }: { pr: PullRequest; open: boolean; onClick: () => void }) {
  const state = usePullRequestState(pr);
  const StateIcon = state.icon;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-fg hover:bg-hover"
    >
      <span className={cn("flex size-9 flex-none items-center justify-center rounded-lg border border-edge bg-panel", state.className)}>
        <StateIcon size={17} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[13.5px] font-semibold">{pr.title}</span>
        <PullRequestMeta pr={pr} />
      </span>
      <Chevron size={15} className="flex-none text-subtle @[720px]:hidden" aria-hidden="true" />
    </button>
  );
}

/** One pull request's branch, link and changed files; a file opens its diff. */
function PullRequestDetail({
  projectId,
  threadId,
  pr,
  header = false,
}: {
  projectId: string;
  threadId: string;
  pr: PullRequest;
  header?: boolean;
}) {
  const t = useT();
  // A new commit moves updatedAt; the server answers from its cache while the commit stays the same.
  const { data, isPending, error } = useQuery({
    queryKey: ["pullFiles", projectId, threadId, pr.repo, pr.number, pr.updatedAt],
    queryFn: () => api.pullRequestFiles(projectId, threadId, pr.repo, pr.number),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {header ? (
          <div className="min-w-40 flex-1">
            <p className="text-[14px] font-semibold text-fg">{pr.title}</p>
            <PullRequestMeta pr={pr} branch />
          </div>
        ) : (
          pr.branch && <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-subtle">{pr.branch}</span>
        )}
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto flex flex-none items-center gap-1.5 rounded-lg border border-edge bg-panel px-2.5 py-1 text-xs text-fg hover:bg-hover"
        >
          {t("pr.openOnGithub")}
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>
      {isPending ? (
        <p className="flex items-center gap-2 text-[13px] text-subtle">
          <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
          {t("common.loading")}
        </p>
      ) : error ? (
        <p className="text-[13px] text-bad">{t("pr.filesFailed")}</p>
      ) : (
        <>
          <ul className="flex flex-col overflow-hidden rounded-lg border border-line">
            {data.files.map((file) => (
              <FileRow key={file.path} file={file} />
            ))}
          </ul>
          {data.truncated && <p className="text-xs text-subtle">{t("pr.filesTruncated", { count: data.files.length })}</p>}
        </>
      )}
    </div>
  );
}

function FileRow({ file }: { file: PullFile }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t("pr.showDiff", { path: file.path })}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[12px] hover:bg-hover"
      >
        <Chevron size={13} className="flex-none text-subtle" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate", file.status === "removed" ? "text-subtle line-through" : "text-body")} title={file.path}>
            {file.path}
          </span>
          {file.previousPath && (
            <span className="block truncate text-[11px] text-subtle">{t("pr.renamedFrom", { path: file.previousPath })}</span>
          )}
        </span>
        <span className="flex-none tabular-nums text-ok">+{file.additions}</span>
        <span className="flex-none tabular-nums text-bad">−{file.deletions}</span>
      </button>
      {open && (file.patch ? <Patch patch={file.patch} /> : <p className="px-3 pb-2 text-xs text-subtle">{t("pr.noPatch")}</p>)}
    </li>
  );
}

/** A file's diff hunks, colored like a diff. */
function Patch({ patch }: { patch: string }) {
  const lines = useCodeLines(patch, "diff");
  return (
    <pre className="overflow-x-auto border-t border-line bg-panel py-1.5 font-mono text-[11.5px] leading-[1.55] text-body">
      {lines ? (
        lines.map((line, i) => (
          <div key={i} className={cn("min-w-max px-3", lineClass(line), line[0]?.kind === "meta" && "text-subtle")}>
            <CodeTokens line={line} />
            {line.length === 0 && " "}
          </div>
        ))
      ) : (
        <div className="px-3">{patch}</div>
      )}
    </pre>
  );
}
