import type { MessageKey } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import type { VisualCheckCard as Card, VisualCheckStatus } from "@myrel/protocol";
import { Link } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, CircleDashed, CircleX, Image, LoaderCircle, ScanEye } from "lucide-react";
import { cn } from "../../lib/ui";
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

/**
 * One round of a visual check (ProjectSettings.visualCheck), in the thread that asked for it: who
 * judged it, what must change with the screenshot that shows it, and the contact sheets. Myrel
 * edits the card as the round goes from running to its result.
 */
export function VisualCheckCard({ card, projectId }: { card: Card; projectId: string }) {
  const t = useT();
  const { go } = useProjectView();
  const tone = TONE[card.status];
  const Icon = tone.icon;
  const open = (path: string) => go("files", { item: path });

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
          <p className="font-mono text-[11.5px]">
            {SCORES.map((k) => `${t(`visualCheck.score.${k}` as MessageKey)} ${card.scores![k]}`).join(" · ")}
          </p>
        )}
        {card.status === "running" && card.evaluatorThreadId && (
          <p>
            <Link
              to="/projects/$projectId/threads/$threadId"
              params={{ projectId, threadId: card.evaluatorThreadId }}
              className="text-link hover:underline"
            >
              {t("visualCheck.openEvaluator")}
            </Link>
          </p>
        )}
      </div>

      {card.note && <p className="mt-2 text-xs text-body">{card.note}</p>}

      {card.blocking.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs font-semibold text-fg">{t("visualCheck.mustFix")}</h4>
          <ul className="mt-1.5 space-y-2">
            {card.blocking.map((b) => (
              <li key={`${b.screen}-${b.evidence}-${b.problem.slice(0, 40)}`} className="flex gap-2">
                <span className="mt-[7px] size-1.5 flex-none rounded-full bg-bad" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="font-mono text-[11.5px] text-subtle">{b.screen}</span>
                  <span className="block text-body">{b.problem}</span>
                  <button type="button" onClick={() => open(b.evidence)} className="mt-0.5 inline-flex items-center gap-1 text-xs text-link hover:underline">
                    <Image size={12} aria-hidden="true" />
                    {fileName(b.evidence)}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(card.sheets.length > 0 || card.summary) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {card.summary && (
            <button
              type="button"
              onClick={() => open(card.summary!)}
              className="rounded-lg border border-edge bg-panel px-2.5 py-1 text-xs text-fg hover:bg-hover"
            >
              {t("visualCheck.summary")}
            </button>
          )}
          {card.sheets.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => open(s)}
              className="inline-flex items-center gap-1 rounded-lg border border-edge bg-panel px-2.5 py-1 text-xs text-fg hover:bg-hover"
            >
              <Image size={12} aria-hidden="true" />
              {fileName(s).replace(/\.sheet\.png$/, "")}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
