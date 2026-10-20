import { checklistProgress, parseChecklist } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import { CircleCheck, CircleDashed, CircleMinus, CircleX, LoaderCircle } from "lucide-react";
import { cn } from "../../lib/ui";

/**
 * A thread agent's plan as a checklist with a progress bar. A task's own steps
 * are indented under the plan step they run in; skipped steps stay visible,
 * struck through, so people see what the agent chose not to do.
 */
export function Checklist({ text, live = true }: { text: string; live?: boolean }) {
  const t = useT();
  const { title, items } = parseChecklist(text);
  if (items.length === 0) return <div className="whitespace-pre-wrap text-[13px] text-muted">{text}</div>;
  const { done, total } = checklistProgress(items);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-subtle">
        <span className="truncate">{title || t("checklist.progress")}</span>
        <span className="ml-auto font-mono">
          {done} / {total}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={t("checklist.progress")}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-1 overflow-hidden rounded bg-[#222227]"
      >
        <div className="h-full rounded bg-accent transition-all" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {items.map((item, i) => (
          <li
            key={i}
            className={cn(
              "flex items-start gap-2",
              item.depth === 1 && "ml-6 text-xs",
              item.depth === 2 && "ml-12 text-xs",
              item.state === "done" ? "text-muted" : item.state === "active" ? "font-medium text-fg" : "text-subtle",
              item.state === "skipped" && "line-through decoration-subtle",
            )}
          >
            <span className="mt-0.5 flex-none">
              {item.state === "done" && <CircleCheck size={15} className="text-ok" aria-label={t("checklist.done")} />}
              {item.state === "active" &&
                (live ? (
                  <LoaderCircle size={15} className="animate-spin text-accent" aria-label={t("checklist.inProgress")} />
                ) : (
                  <CircleDashed size={15} className="text-accent" aria-label={t("checklist.stopped")} />
                ))}
              {item.state === "todo" && <CircleDashed size={15} aria-label={t("checklist.todo")} />}
              {item.state === "failed" && <CircleX size={15} className="text-bad" aria-label={t("checklist.failed")} />}
              {item.state === "skipped" && <CircleMinus size={15} aria-label={t("checklist.skipped")} />}
            </span>
            {item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** An agent's plan as a card in the conversation, where the work started. It stays once the work is done. */
export function PlanCard({ text, live, id }: { text: string; live: boolean; id?: string }) {
  return (
    <div className="flex gap-3.5">
      {/* Lines up with the agent's messages, under its mark. */}
      <span className="w-7 flex-none" aria-hidden="true" />
      <div id={id} className="min-w-0 flex-1 scroll-mt-4 rounded-xl border border-line bg-raised px-3.5 py-3">
        <Checklist text={text} live={live} />
      </div>
    </div>
  );
}

/**
 * The thread's progress in one line, pinned above the conversation while the
 * agent works: the step it is on and how many are done. The full list is the
 * plan card in the conversation; clicking jumps to it.
 */
export function PlanProgress({ text, live, onOpen }: { text: string; live: boolean; onOpen?: () => void }) {
  const t = useT();
  const { title, items } = parseChecklist(text);
  if (items.length === 0) return null;
  const { done, total } = checklistProgress(items);
  const step = items.findLast((i) => i.state === "active") ?? items.find((i) => i.state === "failed");
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className="flex w-full flex-col gap-1.5 text-left enabled:hover:[&_.plan-step]:text-fg"
    >
      <span className="flex w-full items-center gap-2 text-xs">
        {step?.state === "failed" ? (
          <CircleX size={13} className="flex-none text-bad" aria-hidden="true" />
        ) : live && step ? (
          <LoaderCircle size={13} className="flex-none animate-spin text-accent" aria-hidden="true" />
        ) : done === total ? (
          <CircleCheck size={13} className="flex-none text-ok" aria-hidden="true" />
        ) : (
          <CircleDashed size={13} className="flex-none text-subtle" aria-hidden="true" />
        )}
        <span className="plan-step truncate text-muted transition-colors">{step?.text ?? (title || t("checklist.progress"))}</span>
        <span className="ml-auto flex-none font-mono text-subtle">
          {done} / {total}
        </span>
      </span>
      <span
        role="progressbar"
        aria-label={t("checklist.progress")}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="block h-1 w-full overflow-hidden rounded bg-[#222227]"
      >
        <span className="block h-full rounded bg-accent transition-all" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </span>
    </button>
  );
}
