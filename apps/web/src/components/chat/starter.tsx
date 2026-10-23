import { STARTER_EXAMPLES, type StarterExample, type StarterStep, starterDraft, starterSteps } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { Me, Project } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ChevronDown, Clock, LayoutTemplate, type LucideIcon, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { api, githubStatusQuery, meQuery, projectReposQuery, runnersQuery } from "../../lib/api";
import { cn, GhostButton } from "../../lib/ui";
import { useOpenProjectSettings } from "../project-settings-dialog";

const ICONS: Record<StarterExample, LucideIcon> = { page: LayoutTemplate, research: Search, routine: Clock };

/** Example tasks under an empty project chat; a pick goes into the message box, not straight to Myrel. */
export function StarterExamples({ onPick }: { onPick: (text: string, select: [number, number]) => void }) {
  const t = useT();
  return (
    <div className="grid w-full gap-2.5 text-left @lg:grid-cols-3">
      {STARTER_EXAMPLES.map((id) => {
        const Icon = ICONS[id];
        return (
          <button
            key={id}
            type="button"
            onClick={() => {
              const draft = starterDraft(t(`starter.${id}.prompt`));
              onPick(draft.text, draft.select);
            }}
            className="flex flex-col items-start gap-1.5 rounded-xl border border-line bg-raised px-3.5 py-3 text-left transition-colors hover:border-edge hover:bg-hover"
          >
            <span className="flex items-center gap-2 text-[13px] font-medium">
              <Icon size={15} className="flex-none text-accent" aria-hidden="true" />
              {t(`starter.${id}.title`)}
            </span>
            <span className="text-xs text-subtle">{t(`starter.${id}.body`)}</span>
            <span className="mt-auto pt-1 text-[11.5px] text-muted">{t(`starter.${id}.result`)}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The owner's "Get started" list, until every step is done or they hide it
 * (once for the account, on every device). Null while it does not apply.
 */
function useStarter(project: Project, asked: boolean) {
  const queryClient = useQueryClient();
  const me = useQuery(meQuery);
  const on = project.role === "owner" && me.data?.onboarded === false;
  const runners = useQuery({ ...runnersQuery, enabled: on });
  const github = useQuery({ ...githubStatusQuery, enabled: on });
  const configured = github.data?.configured;
  const repos = useQuery({ ...projectReposQuery(project.id), enabled: on && !!configured });
  const finish = useMutation({
    mutationFn: () => api.markOnboarded(),
    onSuccess: () => queryClient.setQueryData<Me>(meQuery.queryKey, (old) => old && { ...old, onboarded: true }),
  });

  const steps =
    on && runners.data && github.data && (!configured || repos.data)
      ? starterSteps({
          asked,
          computers: runners.data.length,
          github: configured ? repos.data!.length > 0 : null,
        })
      : null;
  const complete = !!steps?.every((s) => s.done);
  const { mutate, isIdle } = finish;
  useEffect(() => {
    if (complete && isIdle) mutate();
  }, [complete, isIdle, mutate]);

  if (!steps || complete || !finish.isIdle) return null;
  return { steps, hide: () => finish.mutate() };
}

/**
 * The list itself: open in an empty chat, folded to one line above the
 * conversation once the project has messages.
 */
export function StarterList({ project, asked, folded = false }: { project: Project; asked: boolean; folded?: boolean }) {
  const t = useT();
  const starter = useStarter(project, asked);
  const [open, setOpen] = useState(!folded);
  if (!starter) return null;
  const done = starter.steps.filter((s) => s.done).length;
  const total = starter.steps.length;

  return (
    <section
      aria-label={t("starter.title")}
      className={cn("w-full overflow-hidden rounded-xl border border-line bg-panel text-left", folded && "max-w-[760px]")}
    >
      <div className="flex items-center gap-2 px-3.5 py-2.5 text-[13px]">
        {folded ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={t("starter.open", { done, total })}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <Progress done={done} total={total} />
            <span className="font-medium">{t("starter.title")}</span>
            <span className="text-subtle">{t("starter.progress", { done, total })}</span>
            <ChevronDown size={14} className={cn("text-subtle transition-transform", open && "rotate-180")} aria-hidden="true" />
          </button>
        ) : (
          <span className="flex flex-1 items-center gap-2">
            <span className="font-medium">{t("starter.title")}</span>
            <span className="text-subtle">{t("starter.progress", { done, total })}</span>
          </span>
        )}
        <button type="button" onClick={starter.hide} className="text-xs text-subtle hover:text-fg">
          {t("starter.hide")}
        </button>
      </div>
      {open && (
        <ul className="border-t border-line">
          {starter.steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ul>
      )}
    </section>
  );
}

function StepRow({ step }: { step: StarterStep }) {
  const t = useT();
  const openSettings = useOpenProjectSettings();
  const hint =
    step.id === "computer" ? t("starter.step.computerHint") : step.id === "github" ? t("starter.step.githubHint") : null;
  const action = step.done ? null : step.id === "computer" ? (
    <Link
      to="/devices"
      className="inline-flex h-7 flex-none items-center rounded-lg border border-edge bg-raised px-2.5 text-xs hover:bg-hover"
    >
      {t("starter.connect")}
    </Link>
  ) : step.id === "github" ? (
    <GhostButton type="button" onClick={() => openSettings("github")} className="h-7 flex-none text-xs">
      {t("starter.connect")}
    </GhostButton>
  ) : null;

  return (
    <li className="flex items-center gap-2.5 border-line px-3.5 py-2.5 text-[13px] [&+&]:border-t">
      <span
        className={cn(
          "flex size-[18px] flex-none items-center justify-center rounded-full border-[1.5px]",
          step.done ? "border-ok bg-ok text-ground" : "border-edge",
        )}
      >
        {step.done && <Check size={11} strokeWidth={3.5} aria-hidden="true" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn(step.done && "text-subtle line-through decoration-edge")}>
          {t(`starter.step.${step.id}`)}
          {step.optional && !step.done && <span className="ml-1.5 text-xs text-subtle">{t("starter.optional")}</span>}
        </span>
        {hint && !step.done && <span className="text-xs text-subtle">{hint}</span>}
      </span>
      {action}
    </li>
  );
}

/** A small ring that fills as steps are done. */
function Progress({ done, total }: { done: number; total: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className="flex-none" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="stroke-edge" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        strokeWidth="2"
        className="stroke-accent"
        strokeDasharray={`${(c * done) / total} ${c}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
