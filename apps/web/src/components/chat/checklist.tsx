import { parseChecklist } from "@altair/client";
import { CircleCheck, CircleDashed, LoaderCircle } from "lucide-react";
import { cn } from "../../lib/ui";

/** A thread agent's `update_status` checklist with a progress bar. */
export function Checklist({ text, live = true }: { text: string; live?: boolean }) {
  const { title, items } = parseChecklist(text);
  if (items.length === 0) return <div className="whitespace-pre-wrap text-[13px] text-muted">{text}</div>;
  const done = items.filter((i) => i.state === "done").length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-subtle">
        <span className="truncate">{title || "Progress"}</span>
        <span className="ml-auto font-mono">
          {done} / {items.length}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={0}
        aria-valuemax={items.length}
        aria-valuenow={done}
        className="h-1 overflow-hidden rounded bg-[#222227]"
      >
        <div className="h-full rounded bg-accent transition-all" style={{ width: `${(done / items.length) * 100}%` }} />
      </div>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {items.map((item, i) => (
          <li
            key={i}
            className={cn(
              "flex items-start gap-2",
              item.state === "done" ? "text-muted" : item.state === "active" ? "font-medium text-fg" : "text-subtle",
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
            </span>
            {item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
