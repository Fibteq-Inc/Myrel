import { type ChecklistItem, checklistProgress, freshSteps, parseChecklist } from "@myrel/client";
import type { PlanUpdate } from "@myrel/protocol";
import { useT } from "@myrel/i18n/react";
import { ChevronDown, CircleCheck, CircleDashed, CircleMinus, CircleX, ListChecks, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { cn } from "../../lib/ui";

/**
 * A thread agent's plan as a checklist with a progress bar. A task's own steps
 * are indented under the plan step they run in; skipped steps stay visible,
 * struck through, so people see what the agent chose not to do.
 */
export function Checklist({ text, live = true, fresh }: { text: string; live?: boolean; fresh?: ReadonlySet<string> }) {
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
            <span>
              {item.text}
              {item.depth === 0 && fresh?.has(item.text) && (
                <span className="ml-1.5 rounded-full border border-accent px-1.5 text-[10px] font-semibold text-accent">
                  {t("checklist.new")}
                </span>
              )}
            </span>
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

/** The plan steps each person has had in view, per plan (thread and title), for this session. */
const seenSteps = new Map<string, Set<string>>();

/**
 * The plan steps added since the person last opened the plan. A plan seen for
 * the first time counts as seen, so only steps the agent adds later are new.
 */
function useFreshSteps(key: string, items: ChecklistItem[]) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const shown = () => new Set(items.filter((i) => i.depth === 0).map((i) => i.text));
  if (!seenSteps.has(key)) seenSteps.set(key, shown());
  const fresh = freshSteps(items, seenSteps.get(key)!);
  const markSeen = () => {
    seenSteps.set(key, shown());
    rerender();
  };
  return { fresh, markSeen };
}

/**
 * The thread's progress in one line, pinned above the conversation: the step
 * the agent is on and how many are done, with a badge when the agent added
 * steps. Clicking opens the whole plan right there, so nobody has to scroll
 * back to the plan card; the card stays where the work started.
 */
export function PlanProgress({
  planKey,
  text,
  live,
  open,
  onOpenChange,
  onJump,
}: {
  /** Which plan this is (thread and plan title), so new steps are told apart per plan. */
  planKey: string;
  text: string;
  live: boolean;
  /** Whether the whole plan is open under the line; a plan update note can open it too. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Scrolls to the plan card in the conversation. */
  onJump?: () => void;
}) {
  const t = useT();
  const panelId = useId();
  const { title, items } = parseChecklist(text);
  const { fresh, markSeen } = useFreshSteps(planKey, items);
  // Closing the panel is when the person has seen the new steps.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) markSeen();
    wasOpen.current = open;
  });
  const toggle = useCallback(() => onOpenChange(!open), [open, onOpenChange]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && toggle();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, toggle]);
  if (items.length === 0) return null;
  const { done, total } = checklistProgress(items);
  const step = items.findLast((i) => i.state === "active") ?? items.find((i) => i.state === "failed");
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full flex-col gap-1.5 text-left hover:[&_.plan-step]:text-fg"
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
          {!open && fresh.size > 0 && (
            <span className="flex-none rounded-full bg-accent px-1.5 text-[10px] font-bold leading-4 text-ground">
              {t("checklist.newSteps", { count: fresh.size })}
            </span>
          )}
          <span className="ml-auto flex-none font-mono text-subtle">
            {done} / {total}
          </span>
          <ChevronDown
            size={13}
            className={cn("flex-none text-subtle transition-transform", open && "rotate-180")}
            aria-hidden="true"
          />
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
      {open && (
        <div id={panelId} className="mt-3 flex max-h-[50vh] flex-col gap-3 overflow-y-auto pb-1">
          <Checklist text={text} live={live} fresh={fresh} />
          {onJump && (
            <button
              type="button"
              onClick={() => {
                toggle();
                onJump();
              }}
              className="self-start text-xs text-accent hover:underline"
            >
              {t("checklist.openCard")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A note at the end of the conversation that the agent added, dropped or failed
 * plan steps while the plan card sat further up. It reads as one line; opening
 * it shows just what changed, and from there the whole plan.
 */
export function PlanUpdateNote({ update, onOpenPlan }: { update: PlanUpdate; onOpenPlan?: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const parts = [
    update.added.length > 0 && <span className="text-accent">{t("planUpdate.added", { count: update.added.length })}</span>,
    update.removed.length > 0 && <span>{t("planUpdate.removed", { count: update.removed.length })}</span>,
    update.failed.length > 0 && <span className="text-bad">{t("planUpdate.failed", { count: update.failed.length })}</span>,
  ].filter(Boolean);
  const rows: [string, string, string][] = [
    ...update.added.map((s): [string, string, string] => ["+", s, "text-fg"]),
    ...update.removed.map((s): [string, string, string] => ["−", s, "text-subtle line-through decoration-subtle"]),
    ...update.failed.map((s): [string, string, string] => ["✗", s, "text-bad"]),
  ];
  return (
    <div className="flex gap-3.5">
      {/* Lines up with the agent's messages, under its mark. */}
      <span className="w-7 flex-none" aria-hidden="true" />
      <div className="min-w-0 flex-1 rounded-xl border border-dashed border-edge text-xs text-muted">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:text-fg"
        >
          <ListChecks size={13} className="flex-none text-subtle" aria-hidden="true" />
          <span className="min-w-0 truncate">
            {t("planUpdate.title")}
            {parts.map((p, i) => (
              <span key={i}>
                {" · "}
                {p}
              </span>
            ))}
          </span>
          <ChevronDown size={13} className={cn("ml-auto flex-none text-subtle transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
        {open && (
          <div className="flex flex-col gap-1.5 px-3 pb-2.5">
            <ul className="flex flex-col gap-1 text-[13px]">
              {rows.map(([mark, step, cls], i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="w-3.5 flex-none text-center text-subtle">{mark}</span>
                  <span className={cls}>{step}</span>
                </li>
              ))}
            </ul>
            {onOpenPlan && (
              <button type="button" onClick={onOpenPlan} className="self-start text-accent hover:underline">
                {t("planUpdate.openPlan")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
