import type { MessageKey } from "@myrel/i18n";
import { useI18n, useT } from "@myrel/i18n/react";
import { PROMPT_PARTS, type PromptPart, type PromptSize, promptGauge } from "@myrel/protocol";
import { useFormat } from "../../lib/format";
import { cn } from "../../lib/ui";
import { Menu, MenuLabel } from "../ui/menu";
import { ComposerButton } from "./composer-button";

const PART_COLORS: Record<PromptPart, string> = {
  instructions: "bg-edge-strong",
  knowledge: "bg-ok",
  brief: "bg-merged",
  conversation: "bg-accent",
  notes: "bg-tab-ring",
  skills: "bg-muted",
  other: "bg-check",
};

const LEVEL_STROKE = { ok: "stroke-subtle", near: "stroke-warn", dropped: "stroke-bad" } as const;

function usePercent() {
  const { locale } = useI18n();
  return (share: number) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(share);
}

/** The small ring on the context button: how full the last turn's prompt was. */
function ContextRing({ prompt }: { prompt: PromptSize }) {
  const { share, level } = promptGauge(prompt);
  const r = 5;
  const length = 2 * Math.PI * r;
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" className="flex-none -rotate-90" aria-hidden="true">
      <circle cx={7} cy={7} r={r} fill="none" strokeWidth={2.5} className="stroke-edge" />
      <circle
        cx={7}
        cy={7}
        r={r}
        fill="none"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={`${Math.max(0.5, share * length)} ${length}`}
        className={LEVEL_STROKE[level]}
      />
    </svg>
  );
}

/** Composer control in a thread, once its agent had a turn: how full that turn's prompt was, opening what it held. */
export function ContextPicker({ prompt }: { prompt: PromptSize }) {
  const t = useT();
  const percent = usePercent();
  const { share, level } = promptGauge(prompt);
  return (
    <Menu
      label={t("context.ring", { percent: percent(share) })}
      kind="dialog"
      side="top"
      trigger={
        <ComposerButton>
          <ContextRing prompt={prompt} />
          <span className={cn("tabular-nums", level === "near" ? "text-warn" : level === "dropped" && "text-bad")}>{percent(share)}</span>
        </ComposerButton>
      }
      className="flex-none rounded-lg"
      panelClassName="w-80 max-w-[calc(100vw-1rem)] max-h-[min(34rem,75vh)] overflow-y-auto"
    >
      {() => <ContextSection prompt={prompt} />}
    </Menu>
  );
}

/** What Myrel put in the agent's prompt on its last turn, by kind, and what a long thread left out. */
function ContextSection({ prompt }: { prompt: PromptSize }) {
  const t = useT();
  const fmt = useFormat();
  const percent = usePercent();
  const { share, level } = promptGauge(prompt);
  const parts = PROMPT_PARTS.filter((p) => prompt.parts[p] > 0);
  const total = Math.max(prompt.limit, prompt.chars);
  return (
    <>
      <div className="flex items-baseline justify-between pr-2.5">
        <MenuLabel>{t("context.title")}</MenuLabel>
        <span className={cn("text-xs tabular-nums", level === "ok" ? "text-subtle" : level === "near" ? "text-warn" : "text-bad")}>{percent(share)}</span>
      </div>
      <div className="px-2.5 pb-2 pt-1">
        <div className="flex h-2 overflow-hidden rounded-full bg-line" aria-hidden="true">
          {parts.map((p) => (
            <span key={p} className={PART_COLORS[p]} style={{ width: `${(prompt.parts[p] / total) * 100}%` }} />
          ))}
        </div>
        <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs tabular-nums">
          {parts.map((p) => (
            <div key={p} className="contents">
              <dt className="flex min-w-0 items-center gap-1.5 text-muted">
                <span className={cn("size-2 flex-none rounded-sm", PART_COLORS[p])} aria-hidden="true" />
                <span className="truncate">{t(`context.part.${p}` as MessageKey)}</span>
              </dt>
              <dd className="text-right text-body">{fmt.tokens(prompt.parts[p])}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-1.5 text-xs tabular-nums text-subtle">{t("context.size", { chars: fmt.tokens(prompt.chars), limit: fmt.tokens(prompt.limit) })}</p>
        {level !== "ok" && (
          <div className={cn("mt-2 rounded-md border px-2.5 py-2 text-xs leading-relaxed text-body", level === "near" ? "border-warn-line bg-warn-soft" : "border-bad-line bg-bad-soft")}>
            {level === "near" ? (
              t("context.near")
            ) : (
              <>
                {prompt.droppedMessages > 0 && <p>{t("context.dropped", { count: prompt.droppedMessages })}</p>}
                {prompt.droppedNotes > 0 && <p>{t("context.droppedNotes", { count: prompt.droppedNotes })}</p>}
                {prompt.cut && <p>{t("context.cut")}</p>}
              </>
            )}
            <p className="mt-1 text-subtle">{t("context.advice")}</p>
          </div>
        )}
        <p className="mt-2 text-xs leading-relaxed text-subtle">{t("context.hint")}</p>
      </div>
    </>
  );
}

/** The prompt line in a reply's stats breakdown: its size against the limit, and what was left out. */
export function promptStatsValue(prompt: PromptSize, t: ReturnType<typeof useT>, tokens: (n: number) => string): string {
  const size = t("stats.promptValue", { chars: tokens(prompt.chars), limit: tokens(prompt.limit) });
  return prompt.droppedMessages > 0 ? `${size} · ${t("stats.promptDropped", { count: prompt.droppedMessages })}` : size;
}
