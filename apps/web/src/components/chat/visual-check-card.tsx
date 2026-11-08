import type { MessageKey } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import type { VisualCheckAction, VisualCheckCard as Card, VisualCheckStatus } from "@myrel/protocol";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, CircleDashed, CircleX, Image, LoaderCircle, ScanEye } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { cn, errorMessage } from "../../lib/ui";
import { useProjectView } from "../project-view";

const TONE: Record<VisualCheckStatus, { icon: typeof CircleCheck; className: string }> = {
  running: { icon: LoaderCircle, className: "text-accent" },
  passed: { icon: CircleCheck, className: "text-ok" },
  failed: { icon: CircleX, className: "text-bad" },
  partial: { icon: CircleDashed, className: "text-warn" },
  not_checked: { icon: CircleAlert, className: "text-warn" },
};

const SCORES = ["functionality", "craft", "design", "originality"] as const;

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A project file as an image URL for as long as the component shows it. */
function useFileImage(projectId: string, path: string | null) {
  const { data: blob } = useQuery({
    queryKey: ["projects", projectId, "file-image", path],
    queryFn: () => api.getFile(projectId, path!),
    enabled: !!path,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

/**
 * One round of a visual check (ProjectSettings.visualCheck), in the thread that asked for it: who
 * judged it, the screenshot with each finding framed and numbered in red next to the numbered list
 * of what must change, the contact sheets and what changed against the approved screenshots, and
 * the person's two answers: accept the round as it is, or make its screenshots the approved ones.
 */
export function VisualCheckCard({ card, projectId, threadId }: { card: Card; projectId: string; threadId: string }) {
  const t = useT();
  const { go } = useProjectView();
  const tone = TONE[card.status];
  const Icon = tone.icon;
  const open = (path: string) => go("files", { item: path });
  // One tab per marked screenshot, in the order its first finding comes; the first one shows.
  const images = [...new Set(card.blocking.map((b) => b.image).filter((i): i is string => !!i))];
  const [shown, setShown] = useState<string | null>(null);
  const current = shown && images.includes(shown) ? shown : (images[0] ?? null);
  const url = useFileImage(projectId, current);
  const act = useMutation({ mutationFn: (action: VisualCheckAction) => api.visualCheckAction(projectId, threadId, card.id, action) });
  const settled = card.status !== "running";
  const canAccept = settled && card.status !== "passed" && !card.acceptedBy;
  const canApprove = settled && card.status !== "not_checked" && !card.baselineBy;

  return (
    <section className="rounded-xl border border-card bg-raised px-4 py-3.5 text-[13px]" aria-label={t("visualCheck.title", { round: card.round })}>
      <header className="flex items-center gap-2">
        <ScanEye size={16} className="flex-none text-muted" aria-hidden="true" />
        <span className="font-semibold text-fg">{t("visualCheck.title", { round: card.round })}</span>
        <span className={cn("ml-auto flex items-center gap-1.5 font-medium", tone.className)}>
          <Icon size={15} className={card.status === "running" ? "animate-spin" : undefined} aria-hidden="true" />
          {t(`visualCheck.status.${card.status}` as MessageKey)}
        </span>
      </header>

      <div className="mt-1.5 space-y-0.5 text-xs text-subtle">
        {card.evaluator && (
          <p>
            {t("visualCheck.judgedBy", { cli: card.evaluator.cli, model: card.evaluator.model })}
            {card.vision && card.vision !== "passed" && <span className="text-warn"> · {t("visualCheck.visionNotRead")}</span>}
          </p>
        )}
        {card.deterministic && (
          <p>{t("visualCheck.deterministic", { shots: card.deterministic.shots, blocking: card.deterministic.blocking, warnings: card.deterministic.warnings })}</p>
        )}
        {card.scores && (
          <p className="font-mono text-[11.5px]">{SCORES.map((k) => `${t(`visualCheck.score.${k}` as MessageKey)} ${card.scores![k]}`).join(" · ")}</p>
        )}
        {card.evaluatorThreadId && (
          <p>
            <Link to="/projects/$projectId/threads/$threadId" params={{ projectId, threadId: card.evaluatorThreadId }} className="text-link hover:underline">
              {t("visualCheck.openEvaluator")}
            </Link>
          </p>
        )}
      </div>

      {card.note && <p className="mt-2 text-xs text-body">{card.note}</p>}

      {images.length > 0 && (
        <div className="mt-3">
          {images.length > 1 && (
            <div className="mb-2 flex flex-wrap gap-1.5" role="tablist" aria-label={t("visualCheck.screens")}>
              {images.map((img) => (
                <button
                  key={img}
                  type="button"
                  role="tab"
                  aria-selected={img === current}
                  onClick={() => setShown(img)}
                  className={cn(
                    "rounded-md border px-2 py-0.5 font-mono text-[11.5px]",
                    img === current ? "border-accent text-fg" : "border-edge text-muted hover:bg-hover",
                  )}
                >
                  {card.blocking.find((b) => b.image === img)?.screen ?? fileName(img)}
                </button>
              ))}
            </div>
          )}
          {current && (
            <button type="button" onClick={() => open(current)} className="block w-full overflow-hidden rounded-lg border border-edge bg-panel" title={t("visualCheck.openFull")}>
              {url ? (
                <img src={url} alt={t("visualCheck.markedAlt")} className="mx-auto max-h-[420px] w-auto" />
              ) : (
                <span className="block py-16 text-xs text-subtle">{t("visualCheck.loadingImage")}</span>
              )}
            </button>
          )}
        </div>
      )}

      {card.blocking.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs font-semibold text-fg">{t("visualCheck.mustFix")}</h4>
          <ol className="mt-1.5 space-y-2">
            {card.blocking.map((b, i) => (
              <li key={`${b.screen}-${b.evidence}-${i}`} className="flex gap-2">
                <span className="mt-px flex size-5 flex-none items-center justify-center rounded-full bg-bad text-[11px] font-bold text-white">
                  {b.n ?? i + 1}
                </span>
                <span className="min-w-0">
                  <span className="font-mono text-[11.5px] text-subtle">{b.screen}</span>
                  <span className="block text-body">{b.problem}</span>
                  <button
                    type="button"
                    onClick={() => (b.image ? setShown(b.image) : open(b.evidence))}
                    className="mt-0.5 inline-flex items-center gap-1 text-xs text-link hover:underline"
                  >
                    <Image size={12} aria-hidden="true" />
                    {b.image ? t("visualCheck.showOnScreenshot") : fileName(b.evidence)}
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {(card.sheets.length > 0 || card.diffs.length > 0 || card.summary) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {card.summary && (
            <button type="button" onClick={() => open(card.summary!)} className="rounded-lg border border-edge bg-panel px-2.5 py-1 text-xs text-fg hover:bg-hover">
              {t("visualCheck.summary")}
            </button>
          )}
          {card.sheets.map((s) => (
            <button key={s} type="button" onClick={() => open(s)} className="inline-flex items-center gap-1 rounded-lg border border-edge bg-panel px-2.5 py-1 text-xs text-fg hover:bg-hover">
              <Image size={12} aria-hidden="true" />
              {fileName(s).replace(/\.sheet\.png$/, "")}
            </button>
          ))}
          {card.diffs.map((d) => (
            <button key={d} type="button" onClick={() => open(d)} className="inline-flex items-center gap-1 rounded-lg border border-warn-line bg-warn-soft px-2.5 py-1 text-xs text-fg hover:bg-warn-hover">
              <Image size={12} aria-hidden="true" />
              {t("visualCheck.changed", { screen: fileName(d).replace(/\.diff\.png$/, "") })}
            </button>
          ))}
        </div>
      )}

      {(card.acceptedBy || card.baselineBy) && (
        <p className="mt-3 text-xs text-subtle">
          {[card.acceptedBy && t("visualCheck.acceptedBy", { name: card.acceptedBy }), card.baselineBy && t("visualCheck.baselineBy", { name: card.baselineBy })]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {(canAccept || canApprove) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {canAccept && (
            <button
              type="button"
              disabled={act.isPending}
              onClick={() => act.mutate("accept")}
              className="rounded-lg border border-edge bg-panel px-3 py-1.5 text-[13px] text-fg hover:bg-hover disabled:opacity-60"
            >
              {t("visualCheck.accept")}
            </button>
          )}
          {canApprove && (
            <button
              type="button"
              disabled={act.isPending}
              onClick={() => act.mutate("baseline")}
              className="rounded-lg border border-edge bg-panel px-3 py-1.5 text-[13px] text-fg hover:bg-hover disabled:opacity-60"
              title={t("visualCheck.baselineHint")}
            >
              {t("visualCheck.approveBaseline")}
            </button>
          )}
        </div>
      )}
      {act.error && <p className="mt-2 text-xs text-bad">{errorMessage(act.error, t)}</p>}
    </section>
  );
}
