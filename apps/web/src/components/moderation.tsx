import { useT } from "@myrel/i18n/react";
import { MAX_REPORT_NOTE, type Message, ReportReason, type ReportTarget } from "@myrel/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, CircleCheck, Flag, MoreHorizontal } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, membersQuery } from "../lib/api";
import { useProjectContext } from "../lib/project-context";
import { Button, cn, errorMessage, GhostButton } from "../lib/ui";
import { useConfirm } from "./ui/confirm";
import { Menu, MenuItem } from "./ui/menu";

/**
 * Reporting content and blocking members (App Store Guideline 1.2): the Report dialog, a message's
 * "…" menu (Report, and Block for another person's message), and the hook both the menu and the
 * members list block with.
 */

/** A reason, an optional note, then a thank-you that says when reports are reviewed. */
export function ReportDialog({ projectId, target, onClose }: { projectId: string; target: ReportTarget; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState("");
  const send = useMutation({
    mutationFn: () => api.report(projectId, { target, reason: reason!, ...(note.trim() && { note: note.trim() }) }),
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (reason && !send.isPending) send.mutate();
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="report-title"
      // A close event can arrive after the dialog opened again (React's dev double effects); only a real close counts.
      onClose={(e) => !e.currentTarget.open && onClose()}
      onClick={(e) => e.target === e.currentTarget && !send.isPending && onClose()}
      className="m-auto w-[min(440px,calc(100vw-32px))] rounded-2xl border border-line bg-ground p-0 text-fg shadow-2xl backdrop:bg-black/60"
    >
      {send.isSuccess ? (
        <div className="space-y-4 p-5" role="status">
          <h2 id="report-title" className="flex items-center gap-2 text-[15px] font-semibold">
            <CircleCheck size={17} className="text-ok" aria-hidden="true" />
            {t("report.sent")}
          </h2>
          <p className="text-[13px] leading-relaxed text-muted">{t("report.sentBody")}</p>
          <div className="flex justify-end">
            <Button type="button" className="h-9" onClick={onClose} autoFocus>
              {t("common.close")}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4 p-5">
          <div className="space-y-1.5">
            <h2 id="report-title" className="text-[15px] font-semibold">
              {t("report.title")}
            </h2>
            <p className="text-[13px] leading-relaxed text-muted">{t("report.body")}</p>
          </div>
          <fieldset className="space-y-0.5">
            <legend className="mb-1.5 text-[13px] font-medium">{t("report.reason")}</legend>
            {ReportReason.options.map((r) => (
              <label key={r} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] hover:bg-hover">
                <input
                  type="radio"
                  name="report-reason"
                  value={r}
                  checked={reason === r}
                  onChange={() => setReason(r)}
                  className="accent-[var(--color-accent)]"
                />
                {t(`report.reason.${r}`)}
              </label>
            ))}
          </fieldset>
          <label className="block space-y-1.5">
            <span className="block text-[13px] text-muted">{t("report.note")}</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={MAX_REPORT_NOTE}
              rows={3}
              className="w-full resize-y rounded-lg border border-edge bg-raised px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
            />
          </label>
          {send.error && (
            <p className="text-[13px] text-bad">
              {t("report.failed")}: {errorMessage(send.error, t)}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <GhostButton type="button" className="h-9" onClick={onClose} disabled={send.isPending}>
              {t("common.cancel")}
            </GhostButton>
            <Button type="submit" className="h-9" disabled={!reason || send.isPending}>
              {t("report.send")}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/** Blocks a member after asking; their messages disappear once the member list reloads. */
export function useBlockMember(projectId: string) {
  const t = useT();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: membersQuery(projectId).queryKey });
  const block = useMutation({ mutationFn: (userId: string) => api.blockMember(projectId, userId), onSettled: refresh });
  const unblock = useMutation({ mutationFn: (userId: string) => api.unblockMember(projectId, userId), onSettled: refresh });
  return {
    block: async (userId: string, name: string) => {
      const ok = await confirm({
        title: t("block.confirmTitle", { name }),
        body: t("block.confirmBody", { name }),
        action: t("block.confirm"),
        danger: true,
      });
      if (ok) block.mutate(userId);
    },
    unblock: (userId: string) => unblock.mutate(userId),
    pending: block.isPending || unblock.isPending,
    error: block.error ?? unblock.error,
  };
}

/** The "…" on a message someone else wrote (a person or an agent): Report, and Block for a person's. */
export function MessageMenu({ message, me, className = "size-7" }: { message: Message; me: string; className?: string }) {
  const t = useT();
  const { project, names } = useProjectContext();
  const [reporting, setReporting] = useState(false);
  const { block } = useBlockMember(project.id);
  const person = message.authorKind === "user";
  if (message.authorId === me) return null;
  const name = names[message.authorId] ?? t("common.member");
  return (
    <>
      <Menu
        trigger={<MoreHorizontal size={14} aria-hidden="true" />}
        label={t("message.more")}
        align="end"
        className={cn("flex items-center justify-center rounded-md text-subtle hover:bg-hover hover:text-fg", className)}
      >
        {(close) => (
          <>
            <MenuItem
              icon={<Flag size={14} />}
              onSelect={() => {
                close();
                setReporting(true);
              }}
            >
              {t("report.message")}
            </MenuItem>
            {person && names[message.authorId] && (
              <MenuItem
                icon={<Ban size={14} />}
                onSelect={() => {
                  close();
                  void block(message.authorId, name);
                }}
              >
                {t("block.action", { name })}
              </MenuItem>
            )}
          </>
        )}
      </Menu>
      {reporting && (
        <ReportDialog projectId={project.id} target={{ kind: "message", messageId: message.id }} onClose={() => setReporting(false)} />
      )}
    </>
  );
}

/** The Report button on an artifact's toolbar. */
export function ReportArtifactButton({ projectId, artifactId, version }: { projectId: string; artifactId: string; version?: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={t("report.artifact")}
        title={t("report.artifact")}
        onClick={() => setOpen(true)}
        className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
      >
        <Flag size={15} />
      </button>
      {open && (
        <ReportDialog projectId={projectId} target={{ kind: "artifact", artifactId, version }} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
