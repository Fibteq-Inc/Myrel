import type { Decision } from "@altair/protocol";
import { CircleCheck, CircleHelp } from "lucide-react";
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
  const titleId = useId();
  const chosen = answer
    ? decision.options.findIndex((o) => o.label.trim().toLocaleLowerCase() === answer.trim().toLocaleLowerCase())
    : -1;
  const answered = answer !== undefined;

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className={cn(
        "flex flex-col gap-2.5 rounded-xl border p-3.5",
        answered ? "border-line bg-raised" : "border-[#3b3218] bg-[#17150f]",
      )}
    >
      <div className={cn("flex items-center gap-2 text-xs", answered ? "text-subtle" : "text-warn")}>
        {answered ? <CircleCheck size={14} aria-hidden="true" /> : <CircleHelp size={14} aria-hidden="true" />}
        {answered ? "Answered" : "Your call"}
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
                    ? "border-warn bg-[#221e12] hover:bg-[#2a2516]"
                    : "border-[#2e2e34] bg-[#1a1a1e] hover:bg-hover",
                !answered && onChoose ? "cursor-pointer" : "cursor-default",
              )}
            >
              <span className="flex items-center gap-2 font-medium text-fg">
                {option.label}
                {recommended && <span className="text-xs font-normal text-warn">recommended</span>}
                {picked && <CircleCheck size={14} className="ml-auto text-accent" aria-label="Chosen" />}
              </span>
              {option.consequence && <span className="text-[13px] text-muted">{option.consequence}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
