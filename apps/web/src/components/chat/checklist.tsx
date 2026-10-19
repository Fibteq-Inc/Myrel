import { checklistProgress, parseChecklist } from "@altair/client";
import { CircleCheck, CircleDashed, CircleMinus, CircleX, LoaderCircle } from "lucide-react";
import { cn } from "../../lib/ui";

/**
 * A thread agent's plan as a checklist with a progress bar. A task's own steps
 * are indented under the plan step they run in; skipped steps stay visible,
 * struck through, so people see what the agent chose not to do.
 */
export function Checklist({ text, live = true }: { text: string; live?: boolean }) {
  const { title, items } = parseChecklist(text);
  if (items.length === 0) return <div className="whitespace-pre-wrap text-[13px] text-muted">{text}</div>;
  const { done, total } = checklistProgress(items);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-subtle">
        <span className="truncate">{title || "Progress"}</span>
        <span className="ml-auto font-mono">
          {done} / {total}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Progress"
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
              {item.state === "done" && <CircleCheck size={15} className="text-ok" aria-label="Done" />}
              {item.state === "active" &&
                (live ? (
                  <LoaderCircle size={15} className="animate-spin text-accent" aria-label="In progress" />
                ) : (
                  <CircleDashed size={15} className="text-accent" aria-label="Stopped here" />
                ))}
              {item.state === "todo" && <CircleDashed size={15} aria-label="Not started" />}
              {item.state === "failed" && <CircleX size={15} className="text-bad" aria-label="Failed" />}
              {item.state === "skipped" && <CircleMinus size={15} aria-label="Skipped" />}
            </span>
            {item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
