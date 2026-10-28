import { computerTipDue, decisionTipDue } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { Me, Thread, TipId } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Laptop } from "lucide-react";
import { api, meQuery, runnersQuery } from "../../lib/api";
import { GhostButton } from "../../lib/ui";

/** Marks a one-time tip seen for the account; it goes away at once, on every device. */
function useSeeTip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tip: TipId) => api.markTipSeen(tip),
    onMutate: (tip) =>
      queryClient.setQueryData<Me>(meQuery.queryKey, (old) => old && { ...old, tips: [...(old.tips ?? []), tip] }),
  }).mutate;
}

/** Whether a decision card the person can answer carries the note, and how to put it away. */
export function useDecisionTip() {
  const me = useQuery(meQuery);
  const see = useSeeTip();
  return { due: decisionTipDue(me.data?.tips), seen: () => see("decision") };
}

/** The note under the first decision card the person can answer. */
export function DecisionTip({ onSeen }: { onSeen: () => void }) {
  const t = useT();
  return (
    <div className="flex items-start gap-3 text-[13px] text-muted">
      <span className="min-w-0 flex-1">{t("tip.decision")}</span>
      <button type="button" onClick={onSeen} className="flex-none text-xs text-subtle hover:text-fg">
        {t("tip.decision.ok")}
      </button>
    </div>
  );
}

/** After the project's first finished thread, once: offer pairing a computer to someone who has none. */
export function ComputerTip({ threads }: { threads: Thread[] }) {
  const t = useT();
  const me = useQuery(meQuery);
  const tips = me.data?.tips;
  const runners = useQuery({ ...runnersQuery, enabled: !!tips && !tips.includes("computer") });
  const see = useSeeTip();
  if (!runners.data || !computerTipDue({ tips, computers: runners.data.length, threads })) return null;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3.5 text-[13px]">
      <div className="flex items-start gap-2.5">
        <Laptop size={16} className="mt-0.5 flex-none text-accent" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <span className="font-medium text-fg">{t("tip.computer.title")}</span>
          <span className="text-muted">{t("tip.computer.body")}</span>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <GhostButton type="button" onClick={() => see("computer")} className="h-7 text-xs">
          {t("tip.computer.later")}
        </GhostButton>
        <Link
          to="/devices"
          onClick={() => see("computer")}
          className="inline-flex h-7 items-center rounded-lg border border-edge bg-raised px-2.5 text-xs hover:bg-hover"
        >
          {t("tip.computer.connect")}
        </Link>
      </div>
    </section>
  );
}
