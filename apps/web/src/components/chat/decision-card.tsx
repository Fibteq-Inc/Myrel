import { useT } from "@myrel/i18n/react";
import { chosenOption, type Decision, type DecisionAnswer } from "@myrel/protocol";
import { CircleCheck, CircleHelp, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "../../lib/ui";
import { DecisionTip, useDecisionTip } from "./tips";

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
  /** The reply that answered it; null when a message of the person's closed several cards at once. */
  answer?: DecisionAnswer;
  /** Missing when the viewer cannot answer here (e.g. read-only). */
  onChoose?: (label: string) => void;
}) {
  const t = useT();
  const titleId = useId();
  const danger = !!decision.danger;
  const tip = useDecisionTip();
  const showTip = tip.due && answer === undefined && !!onChoose;

  // Answered: one line with the question and the pick, so the conversation moves on.
  if (answer !== undefined) {
    return (
      <div role="group" aria-labelledby={titleId} className="rounded-xl border border-line bg-raised px-3.5 py-2.5 text-sm">
        <AnsweredLine decision={decision} answer={answer} titleId={titleId} />
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className={cn("flex flex-col gap-2.5 rounded-xl border p-3.5", danger ? "border-bad-line bg-bad-soft" : "border-warn-line bg-warn-soft")}
    >
      <div className={cn("flex items-center gap-2 text-xs", danger ? "text-bad" : "text-warn")}>
        {danger ? <TriangleAlert size={14} aria-hidden="true" /> : <CircleHelp size={14} aria-hidden="true" />}
        {danger ? t("decision.danger") : t("decision.yourCall")}
      </div>
      <div id={titleId} className="font-medium text-fg">
        {decision.question}
      </div>
      <OptionList
        decision={decision}
        onPick={
          onChoose &&
          ((label) => {
            if (showTip) tip.seen();
            onChoose(label);
          })
        }
      />
      {showTip && <DecisionTip onSeen={tip.seen} />}
    </div>
  );
}

/**
 * Questions an agent asked together, answered one by one in a single card: the answered ones as a
 * line each on top, the current one with its options, the ones still to come by their question.
 * Each pick goes as the person's reply to that question alone.
 */
export function DecisionSteps({
  decisions,
  answers,
  onChoose,
}: {
  decisions: Decision[];
  /** What answered each question, in order (decisionState); undefined while open. */
  answers?: readonly (DecisionAnswer | undefined)[];
  /** `card`: which of the questions the option is on. Missing when the viewer cannot answer here. */
  onChoose?: (label: string, card: number) => void;
}) {
  const t = useT();
  const titleId = useId();
  const tip = useDecisionTip();
  // A tap moves on to the next question at once, before its message comes back from the server.
  const [tapped, setTapped] = useState<Record<number, string>>({});
  const given = decisions.map((_, i) => (answers?.[i] !== undefined ? answers[i] : tapped[i]));
  const current = given.findIndex((a) => a === undefined);
  const lines = decisions.flatMap((decision, i) => {
    const answer = given[i];
    return answer === undefined ? [] : [<AnsweredLine key={i} decision={decision} answer={answer} titleId={`${titleId}-${i}`} />];
  });

  // Every question answered: their lines, so the conversation moves on.
  if (current < 0) {
    return (
      <div role="group" aria-label={t("decision.answered")} className="flex flex-col gap-2 rounded-xl border border-line bg-raised px-3.5 py-2.5 text-sm">
        {lines}
      </div>
    );
  }

  const decision = decisions[current]!;
  const danger = !!decision.danger;
  const showTip = tip.due && !!onChoose;
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className={cn("flex flex-col gap-2.5 rounded-xl border p-3.5", danger ? "border-bad-line bg-bad-soft" : "border-warn-line bg-warn-soft")}
    >
      <div className={cn("flex items-center gap-2 text-xs", danger ? "text-bad" : "text-warn")}>
        {danger ? <TriangleAlert size={14} aria-hidden="true" /> : <CircleHelp size={14} aria-hidden="true" />}
        <span>
          {danger ? t("decision.danger") : t("decision.yourCall")} · {t("decision.step", { n: current + 1, total: decisions.length })}
        </span>
        <span className="ml-auto flex gap-1" aria-hidden="true">
          {decisions.map((_, i) => (
            <span key={i} className={cn("h-1 w-4 rounded-full", given[i] !== undefined || i === current ? "bg-warn" : "bg-warn-line")} />
          ))}
        </span>
      </div>
      {lines.length > 0 && <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-raised px-3 py-2 text-sm">{lines}</div>}
      <div id={titleId} aria-live="polite" className="font-medium text-fg">
        {decision.question}
      </div>
      <OptionList
        key={current}
        decision={decision}
        onPick={
          onChoose &&
          ((label) => {
            if (showTip) tip.seen();
            setTapped((was) => ({ ...was, [current]: label }));
            onChoose(label, current);
          })
        }
      />
      {decisions.map((next, i) =>
        i > current && given[i] === undefined ? (
          <div key={i} className="rounded-lg border border-dashed border-frame px-3 py-2 text-[13px] text-subtle">
            {i + 1}. {next.question}
          </div>
        ) : null,
      )}
      {showTip && <DecisionTip onSeen={tip.seen} />}
    </div>
  );
}

/** One answered question: the question and the pick (or that a message answered it). */
function AnsweredLine({ decision, answer, titleId }: { decision: Decision; answer: DecisionAnswer; titleId: string }) {
  const t = useT();
  const chosen = chosenOption(decision, answer);
  const picked = chosen >= 0 ? decision.options[chosen]!.label : (answer ?? t("decision.inMessage"));
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <CircleCheck size={14} className="flex-none text-accent" aria-label={t("decision.answered")} />
      <span id={titleId} className="min-w-0 text-muted">
        {decision.question}
      </span>
      <span className={cn("ml-auto", answer === null ? "text-subtle" : "font-medium text-fg")} title={t("decision.chosen")}>
        {picked.length > 80 ? `${picked.slice(0, 80)}…` : picked}
      </span>
    </div>
  );
}

/** A question's options; the recommended one stands out. Without `onPick` they cannot be tapped. */
function OptionList({ decision, onPick }: { decision: Decision; onPick?: (label: string) => void }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2">
      {decision.options.map((option, i) => {
        const recommended = i === decision.recommended;
        return (
          <button
            key={option.label}
            type="button"
            disabled={!onPick}
            onClick={() => onPick?.(option.label)}
            className={cn(
              "flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
              recommended ? "border-warn bg-warn-strong hover:bg-warn-hover" : "border-frame bg-option hover:bg-hover",
              onPick ? "cursor-pointer" : "cursor-default",
            )}
          >
            <span className="flex items-center gap-2 font-medium text-fg">
              {option.label}
              {recommended && <span className="text-xs font-normal text-warn">{t("decision.recommended")}</span>}
            </span>
            {option.consequence && <span className="text-[13px] text-muted">{option.consequence}</span>}
          </button>
        );
      })}
    </div>
  );
}
