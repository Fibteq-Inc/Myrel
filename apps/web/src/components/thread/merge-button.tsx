import { ApiError } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { MergeMethod, MergePullResult, PullMergeState, PullRequest } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitMerge, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { Button, cn, GhostButton } from "../../lib/ui";
import { Checkbox } from "../ui/controls";

/**
 * Merge for a person who can merge into the repository on GitHub themselves; nobody else sees it.
 * While the pull request cannot be merged (CI, conflicts, review, branch rules) it says why.
 * The dialog is the person's go-ahead: merging cannot be undone from Myrel.
 */
export function MergeButton({ projectId, threadId, pr }: { projectId: string; threadId: string; pr: PullRequest }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["pullMerge", projectId, threadId, pr.repo, pr.number, pr.updatedAt],
    queryFn: () => api.pullRequestMergeState(projectId, threadId, pr.repo, pr.number),
    enabled: pr.state === "open",
  });
  if (pr.state !== "open" || !data?.permitted) return null;
  return (
    <>
      <span className="flex items-center gap-2">
        {data.blocked && <span className="text-xs text-subtle">{t(`pr.blocked.${data.blocked}`)}</span>}
        <button
          type="button"
          disabled={data.blocked !== null}
          onClick={() => setOpen(true)}
          className="flex flex-none items-center gap-1.5 rounded-lg bg-merged px-2.5 py-1 text-xs font-medium text-ground hover:opacity-90 disabled:opacity-40"
        >
          <GitMerge size={12} aria-hidden="true" />
          {t("pr.merge")}
        </button>
      </span>
      {open && <MergeDialog projectId={projectId} threadId={threadId} pr={pr} state={data} onClose={() => setOpen(false)} />}
    </>
  );
}

function MergeDialog({
  projectId,
  threadId,
  pr,
  state,
  onClose,
}: {
  projectId: string;
  threadId: string;
  pr: PullRequest;
  state: PullMergeState;
  onClose: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const ref = useRef<HTMLDialogElement>(null);
  const [method, setMethod] = useState<MergeMethod>(state.methods.includes("merge") ? "merge" : state.methods[0]!);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [kept, setKept] = useState<MergePullResult["branchKept"]>(null);
  const merge = useMutation({
    mutationFn: () => api.mergePullRequest(projectId, threadId, pr.repo, pr.number, { method, sha: state.sha, deleteBranch }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["pullMerge", projectId, threadId, pr.repo, pr.number] });
      if (result.branchKept && deleteBranch) setKept(result.branchKept);
      else onClose();
    },
    onError: (err) => {
      // The branch moved: what the dialog showed is stale, so the tab looks again.
      if (err instanceof ApiError && err.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ["pullMerge", projectId, threadId, pr.repo, pr.number] });
        void queryClient.invalidateQueries({ queryKey: ["pullFiles", projectId, threadId, pr.repo, pr.number] });
      }
    },
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  const error = merge.error;
  const headMoved = error instanceof ApiError && (error.body as { error?: string } | null)?.error === "head_moved";
  const files = pr.changedFiles !== null ? t("pr.files", { count: pr.changedFiles }) : "";
  return (
    <dialog
      ref={ref}
      {...{ closedby: merge.isPending ? "none" : "any" }}
      aria-labelledby="merge-title"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && !merge.isPending && onClose()}
      className="m-auto w-[min(440px,calc(100vw-32px))] rounded-2xl border border-edge bg-menu p-0 text-fg shadow-[0_16px_48px_var(--color-shadow)] backdrop:bg-black/60"
    >
      <form
        method="dialog"
        className="flex flex-col gap-3 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (kept) onClose();
          else merge.mutate();
        }}
      >
        <div>
          <h2 id="merge-title" className="text-[15px] font-semibold">
            {t("pr.mergeTitle", { number: pr.number })}
          </h2>
          <p className="mt-0.5 line-clamp-2 text-[13px] text-body">{pr.title}</p>
          <p className="mt-1 text-xs text-subtle">
            {t("pr.mergeBody", { files, additions: pr.additions ?? 0, deletions: pr.deletions ?? 0, sha: state.sha.slice(0, 7) })}
          </p>
        </div>
        {kept ? (
          <p className="text-[13px] text-muted">{t("pr.branchKept", { reason: t(`pr.kept.${kept}`) })}</p>
        ) : (
          <>
            <fieldset className="flex flex-col overflow-hidden rounded-xl border border-line" disabled={merge.isPending}>
              {(["merge", "squash", "rebase"] as const).map((m) => {
                const allowed = state.methods.includes(m);
                return (
                  <label
                    key={m}
                    className={cn(
                      "flex gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0",
                      !allowed ? "cursor-default opacity-45" : method === m ? "cursor-pointer bg-accent-soft" : "cursor-pointer bg-panel hover:bg-hover",
                    )}
                  >
                    <input
                      type="radio"
                      name="merge-method"
                      value={m}
                      checked={method === m}
                      disabled={!allowed}
                      onChange={() => setMethod(m)}
                      className="mt-0.5 size-4 flex-none accent-[var(--color-accent)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium">{t(`pr.method.${m}`)}</span>
                      <span className="block text-xs text-subtle">{t(`pr.method.${m}Hint`)}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {pr.branch && (
              <label className="flex items-center gap-2 text-[13px] text-body">
                <Checkbox checked={deleteBranch} disabled={merge.isPending} onChange={(e) => setDeleteBranch(e.target.checked)} />
                <span className="min-w-0">{t("pr.deleteBranch", { branch: pr.branch })}</span>
              </label>
            )}
            {error && (
              <p role="alert" className="text-[13px] text-bad">
                {headMoved ? t("pr.headMoved") : t("pr.mergeFailed", { message: error.message })}
              </p>
            )}
          </>
        )}
        <div className="mt-1 flex justify-end gap-2">
          {!kept && (
            <GhostButton type="button" onClick={onClose} disabled={merge.isPending} autoFocus className="h-9 px-3">
              {t("common.cancel")}
            </GhostButton>
          )}
          <Button type="submit" disabled={merge.isPending || (headMoved && !kept)}>
            {merge.isPending && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
            {kept ? t("common.close") : merge.isPending ? t("pr.merging") : t("pr.merge")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
