import { useI18n } from "@myrel/i18n/react";
import { type Goal, GOAL_MAX_THREADS } from "@myrel/protocol";
import { Square, Target } from "lucide-react";
import { formatDateTime } from "../../lib/format";
import { useConfirm } from "../ui/confirm";

/**
 * Above the project chat while a standing goal is open: what the coordinator keeps working toward
 * by itself, until when, and a way for any member to stop it.
 */
export function GoalBanner({ goal, onStop }: { goal: Goal; onStop: () => void }) {
  const { t, locale } = useI18n();
  const confirm = useConfirm();
  const stop = async () => {
    if (await confirm({ title: t("goal.stopTitle"), body: t("goal.stopConfirm"), action: t("goal.stop") })) onStop();
  };
  return (
    <div className="flex items-start gap-3 rounded-xl border border-line bg-raised px-3.5 py-2.5 text-[13px]">
      <Target size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("goal.until", { time: formatDateTime(goal.until, locale) })}</p>
        <p className="line-clamp-2 text-subtle" title={goal.text}>
          {goal.text}
        </p>
        <p className="mt-0.5 text-xs text-muted">{t("goal.threads", { count: String(goal.threads), max: String(GOAL_MAX_THREADS) })}</p>
      </div>
      <button
        type="button"
        onClick={stop}
        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
      >
        <Square size={10} aria-hidden="true" />
        {t("goal.stop")}
      </button>
    </div>
  );
}
