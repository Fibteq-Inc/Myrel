import { useT } from "@myrel/i18n/react";
import type { Decision } from "@myrel/protocol";
import { CircleCheck, CircleHelp, TriangleAlert } from "lucide-react";
import { useId } from "react";
import { cn } from "../../lib/ui";

/**
 * A question with 2 to 4 options, one recommended. Picking an option sends
 * its label as the person's reply. Once answered, the card shows the pick.
 */
export function DecisionCard({
  decision,
  answer,
  onChoose,
}: {
  decision: Decision;
  /** The reply that answered it, if any. */
  answer?: string;
  /** Missing when the viewer cannot answer here (e.g. read-only). */
  onChoose?: (label: string) => void;
}) {
  const t = useT();
  const titleId = useId();
  const chosen = answer
    ? decision.options.findIndex((o) => o.label.trim().toLocaleLowerCase() === answer.trim().toLocaleLowerCase())
    : -1;
  const answered = answer !== undefined;
  const danger = !!decision.danger;

  // Answered: one line with the question and the pick, so the conversation moves on.
  if (answered) {
    const picked = chosen >= 0 ? decision.options[chosen]!.label : answer;
    return (
      <div
        role="group"
        aria-labelledby={titleId}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-raised px-3.5 py-2.5 text-sm"
      >
        <CircleCheck size={14} className="flex-none text-accent" aria-label={t("decision.answered")} />
        <span id={titleId} className="min-w-0 text-muted">
          {decision.question}
        </span>
        <span className="ml-auto font-medium text-fg" title={t("decision.chosen")}>
          {picked.length > 80 ? `${picked.slice(0, 80)}…` : picked}
        </span>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className={cn(
        "flex flex-col gap-2.5 rounded-xl border p-3.5",
        answered ? "border-line bg-raised" : danger ? "border-bad-line bg-bad-soft" : "border-warn-line bg-warn-soft",
      )}
    >
      <div className={cn("flex items-center gap-2 text-xs", answered ? "text-subtle" : danger ? "text-bad" : "text-warn")}>
        {answered ? (
          <CircleCheck size={14} aria-hidden="true" />
        ) : danger ? (
          <TriangleAlert size={14} aria-hidden="true" />
        ) : (
          <CircleHelp size={14} aria-hidden="true" />
        )}
        {answered ? t("decision.answered") : danger ? t("decision.danger") : t("decision.yourCall")}
      </div>
      <div id={titleId} className="font-medium text-fg">
        {decision.question}
      </div>
      <div className="flex flex-col gap-2">
        {decision.options.map((option, i) => {
          const recommended = i === decision.recommended;
          const picked = i === chosen;
          return (
            <button
              key={option.label}
              type="button"
              disabled={answered || !onChoose}
              onClick={() => onChoose?.(option.label)}
              aria-pressed={picked}
              className={cn(
                "flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                answered
                  ? picked
                    ? "border-accent/60 bg-accent-soft"
                    : "border-line bg-transparent opacity-60"
                  : recommended
                    ? "border-warn bg-warn-strong hover:bg-warn-hover"
                    : "border-frame bg-option hover:bg-hover",
                !answered && onChoose ? "cursor-pointer" : "cursor-default",
              )}
            >
              <span className="flex items-center gap-2 font-medium text-fg">
                {option.label}
                {recommended && <span className="text-xs font-normal text-warn">{t("decision.recommended")}</span>}
                {picked && <CircleCheck size={14} className="ml-auto text-accent" aria-label={t("decision.chosen")} />}
              </span>
              {option.consequence && <span className="text-[13px] text-muted">{option.consequence}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
