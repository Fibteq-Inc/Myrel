import type { MessageKey } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import {
  CLI_NAMES,
  type CliId,
  type CliModelDefaults,
  CloudCli,
  EFFORT_LEVELS,
  effortsFor,
  type Project,
  type ProjectWorkspace,
  type RunnerCli,
  type Thread,
} from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { Brain, Check, ChevronDown, Laptop, Sparkles, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { projectSettingsQuery, runnersQuery, workspaceQuery, workspacesQuery } from "../../lib/api";
import { cn } from "../../lib/ui";
import { Menu, MenuLabel, MenuSeparator } from "../ui/menu";

export function cliName(id: string): string {
  return CLI_NAMES[id as CliId] ?? id;
}

/**
 * The CLIs the signed-in person can pick for this project's threads. On the project folder's
 * computer, when that computer is theirs (a turn only runs there for its owner) and the project does
 * not always work in the cloud: the CLIs installed there. Otherwise their threads run in the cloud,
 * where any member picks among the cloud CLIs, the project's "CLI in the cloud" being the default
 * (`cloud`). Null when there is nothing to pick.
 */
export type PickableClis = { clis: RunnerCli[]; folderCli: CliId; defaults: CliModelDefaults; cloud?: boolean };

const CLOUD_CLIS: RunnerCli[] = CloudCli.options.map((id) => ({ id, version: null }));

/**
 * The project's local folders on the signed-in person's own computers (only those are listed in
 * runnersQuery), the default first. A thread of theirs works on one of these.
 */
export function useOwnWorkspaces(project: Project): ProjectWorkspace[] {
  const { data: workspace } = useQuery(workspaceQuery(project.id));
  const { data: workspaces = [] } = useQuery({ ...workspacesQuery(project.id), enabled: !!workspace });
  const { data: runners } = useQuery({ ...runnersQuery, enabled: !!workspace });
  return workspaces.filter((w) => runners?.some((r) => r.id === w.runnerId));
}

/** `runnerId`: the computer the thread works on, when it was set to or started on one. */
export function usePickableClis(project: Project, runnerId?: string | null): PickableClis | null {
  const { data: default_, isPending } = useQuery(workspaceQuery(project.id));
  const { data: runners } = useQuery({ ...runnersQuery, enabled: !!default_ });
  const { data: settings } = useQuery(projectSettingsQuery(project.id));
  const own = useOwnWorkspaces(project);
  if (isPending || !settings) return null;
  // The thread's computer, else the person's own (the default first), as the server picks it.
  const workspace = own.find((w) => w.runnerId === runnerId) ?? own[0] ?? default_;
  // Only your own computers are listed, so finding it means it is yours.
  const runner = workspace && runners?.find((r) => r.id === workspace.runnerId);
  const cloud = settings.taskTarget === "cloud" || !workspace || (settings.taskTarget === "auto" && runners !== undefined && !runner);
  if (cloud) return { clis: CLOUD_CLIS, folderCli: settings.cloudCli, defaults: {}, cloud: true };
  if (!runner || runner.clis.length === 0) return null;
  return { clis: runner.clis, folderCli: workspace.cli, defaults: settings.cliModels };
}

/**
 * Composer control in the project chat: the CLIs a new ask's thread may run with. None picked: the
 * project folder's CLI. One: the thread runs with it. Several: Myrel picks the one that fits.
 */
export function AskCliPicker({
  pickable,
  value,
  onChange,
}: {
  pickable: PickableClis;
  value: CliId[];
  onChange: (next: CliId[]) => void;
}) {
  const t = useT();
  const label =
    value.length === 0
      ? cliName(pickable.folderCli)
      : value.length === 1
        ? cliName(value[0]!)
        : t("cliPicker.several", { count: value.length });
  const toggle = (id: CliId) => onChange(value.includes(id) ? value.filter((c) => c !== id) : [...value, id]);
  return (
    <Menu
      label={t("cliPicker.askTitle")}
      side="top"
      trigger={<Trigger label={label} active={value.length > 0} several={value.length > 1} />}
      className={triggerClass}
      panelClassName="w-72"
    >
      {() => (
        <>
          <MenuLabel>{t("cliPicker.askTitle")}</MenuLabel>
          <Option
            role="menuitemradio"
            checked={value.length === 0}
            onSelect={() => onChange([])}
            title={t("cliPicker.default", { cli: cliName(pickable.folderCli) })}
          />
          <MenuSeparator />
          {pickable.clis.map((c) => (
            <Option
              key={c.id}
              role="menuitemcheckbox"
              checked={value.includes(c.id)}
              onSelect={() => toggle(c.id)}
              title={cliName(c.id)}
              note={limitNote(c, t)}
            />
          ))}
          {pickable.clis.length > 1 && <p className="px-2.5 pb-1.5 pt-2 text-xs leading-relaxed text-subtle">{t("cliPicker.askHint")}</p>}
          {pickable.cloud && <p className="px-2.5 pb-1.5 text-xs leading-relaxed text-subtle">{t("cliPicker.cloudHint")}</p>}
        </>
      )}
    </Menu>
  );
}

/** Composer control in a thread: the CLI it runs with from its next turn. */
export function ThreadCliPicker({
  pickable,
  thread,
  onChange,
}: {
  pickable: PickableClis;
  thread: Thread;
  onChange: (cli: CliId | null) => void;
}) {
  const t = useT();
  const current = thread.cli?.id;
  return (
    <Menu
      label={t("cliPicker.threadTitle")}
      side="top"
      trigger={<Trigger label={cliName(current ?? pickable.folderCli)} active={!!current} several={thread.cli?.by === "coordinator"} />}
      className={triggerClass}
      panelClassName="w-72"
    >
      {(close) => (
        <>
          <MenuLabel>{t("cliPicker.threadTitle")}</MenuLabel>
          <Option
            role="menuitemradio"
            checked={!current}
            onSelect={() => {
              if (current) onChange(null);
              close();
            }}
            title={t("cliPicker.default", { cli: cliName(pickable.folderCli) })}
          />
          <MenuSeparator />
          {pickable.clis.map((c) => (
            <Option
              key={c.id}
              role="menuitemradio"
              checked={current === c.id}
              onSelect={() => {
                if (current !== c.id) onChange(c.id);
                close();
              }}
              title={cliName(c.id)}
              note={limitNote(c, t)}
            />
          ))}
          <p className="px-2.5 pb-1.5 pt-2 text-xs leading-relaxed text-subtle">
            {t("cliPicker.threadHint")}
            {pickable.cloud && ` ${t("cliPicker.cloudHint")}`}
          </p>
        </>
      )}
    </Menu>
  );
}

/**
 * Composer control in a thread, when the person has the project on several of their computers: the
 * one it works on from its next turn. None picked: the computer it started on, else the default.
 */
export function ThreadRunnerPicker({
  workspaces,
  thread,
  onChange,
}: {
  workspaces: ProjectWorkspace[];
  thread: Thread;
  onChange: (runnerId: string | null) => void;
}) {
  const t = useT();
  const picked = thread.runner?.by === "person" ? thread.runner.id : null;
  const current = workspaces.find((w) => w.runnerId === thread.runner?.id) ?? workspaces[0]!;
  return (
    <Menu
      label={t("runnerPicker.title")}
      side="top"
      trigger={
        <>
          <Laptop size={14} className={cn("flex-none", picked && "text-accent")} aria-hidden="true" />
          <span className={cn("truncate", picked && "text-fg")}>{current.runnerName}</span>
          <ChevronDown size={12} className="flex-none text-subtle" aria-hidden="true" />
        </>
      }
      className={triggerClass}
      panelClassName="w-72"
    >
      {(close) => (
        <>
          <MenuLabel>{t("runnerPicker.title")}</MenuLabel>
          <Option
            role="menuitemradio"
            checked={!picked}
            onSelect={() => {
              if (picked) onChange(null);
              close();
            }}
            title={
              thread.runner && thread.runner.by === "auto"
                ? t("runnerPicker.started", { computer: current.runnerName })
                : t("cliPicker.default", { cli: workspaces[0]!.runnerName })
            }
          />
          <MenuSeparator />
          {workspaces.map((w) => (
            <Option
              key={w.runnerId}
              role="menuitemradio"
              checked={picked === w.runnerId}
              onSelect={() => {
                if (picked !== w.runnerId) onChange(w.runnerId);
                close();
              }}
              title={w.runnerName}
              note={w.online ? undefined : t("localFolder.offline")}
            />
          ))}
          <p className="px-2.5 pb-1.5 pt-2 text-xs leading-relaxed text-subtle">{t("runnerPicker.hint")}</p>
        </>
      )}
    </Menu>
  );
}

/** An effort level's name, e.g. "xhigh" as "Extra high"; one Myrel does not know shows as the CLI wrote it. */
export function effortName(effort: string, t: ReturnType<typeof useT>): string {
  return (EFFORT_LEVELS as readonly string[]).includes(effort) ? t(`modelPicker.effort.${effort}` as MessageKey) : effort;
}

/**
 * Composer control in a thread: the model and effort its CLI runs with from the next turn. Only for a
 * CLI that lists its models; efforts only those the picked model takes, and none for a model that takes none.
 */
export function ThreadModelPicker({
  pickable,
  thread,
  onChange,
}: {
  pickable: PickableClis;
  thread: Thread;
  onChange: (pick: { cli: CliId; model: string | null; effort: string | null }) => void;
}) {
  const t = useT();
  const cli = (thread.cli?.id as CliId | undefined) ?? pickable.folderCli;
  // In the cloud the project's model runs whichever CLI it is.
  const models = pickable.cloud ? undefined : pickable.clis.find((c) => c.id === cli)?.models;
  if (!models?.length) return null;
  const own = thread.model?.cli === cli ? thread.model : null;
  const project = pickable.defaults[cli];
  const modelId = own?.model ?? project?.model ?? null;
  const model = modelId ? models.find((m) => m.id === modelId) : undefined;
  const efforts = effortsFor(models, model?.id ?? null);
  const effortId = own?.effort ?? project?.effort ?? null;
  const effort = effortId && efforts.includes(effortId) ? effortId : null;
  const pick = (next: { model?: string | null; effort?: string | null }) => {
    const m = next.model !== undefined ? next.model : (own?.model ?? null);
    let e = next.effort !== undefined ? next.effort : (own?.effort ?? null);
    // An effort the new model does not take would be dropped anyway: say so by clearing it.
    if (e && !effortsFor(models, m ?? project?.model ?? null).includes(e)) e = null;
    onChange({ cli, model: m, effort: e });
  };
  const label = [model?.name ?? t("modelPicker.cliDefault"), effort && effortName(effort, t)].filter(Boolean).join(" · ");
  const projectModel = project?.model ? (models.find((m) => m.id === project.model)?.name ?? project.model) : null;
  return (
    <Menu
      label={t("modelPicker.title")}
      side="top"
      trigger={<ModelTrigger label={label} active={!!own} />}
      className={triggerClass}
      panelClassName="w-72 max-h-[min(28rem,70vh)] overflow-y-auto"
    >
      {() => (
        <>
          <MenuLabel>{t("modelPicker.title")}</MenuLabel>
          <Option
            role="menuitemradio"
            checked={!own?.model}
            onSelect={() => pick({ model: null })}
            title={projectModel ? t("modelPicker.projectDefault", { model: projectModel }) : t("modelPicker.cliDefault")}
          />
          {models.map((m) => (
            <Option key={m.id} role="menuitemradio" checked={own?.model === m.id} onSelect={() => pick({ model: m.id })} title={m.name} />
          ))}
          <MenuSeparator />
          <MenuLabel>{t("modelPicker.effort")}</MenuLabel>
          {efforts.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 px-2.5 pb-1.5 pt-1">
              <EffortChip checked={!own?.effort} onSelect={() => pick({ effort: null })} label={t("modelPicker.effortDefault")} />
              {efforts.map((e) => (
                <EffortChip key={e} checked={own?.effort === e} onSelect={() => pick({ effort: e })} label={effortName(e, t)} />
              ))}
            </div>
          ) : (
            <p className="px-2.5 pb-1.5 pt-1 text-xs leading-relaxed text-subtle">{t("modelPicker.noEffort")}</p>
          )}
          <p className="px-2.5 pb-1.5 pt-2 text-xs leading-relaxed text-subtle">{t("cliPicker.threadHint")}</p>
        </>
      )}
    </Menu>
  );
}

function ModelTrigger({ label, active }: { label: string; active: boolean }) {
  return (
    <>
      <Brain size={14} className={cn("flex-none", active && "text-accent")} aria-hidden="true" />
      <span className={cn("truncate", active && "text-fg")}>{label}</span>
      <ChevronDown size={12} className="flex-none text-subtle" aria-hidden="true" />
    </>
  );
}

function EffortChip({ checked, onSelect, label }: { checked: boolean; onSelect: () => void; label: string }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs",
        checked ? "border-accent bg-accent text-ground" : "border-edge text-body hover:bg-hover hover:text-fg",
      )}
    >
      {label}
    </button>
  );
}

/** The line at the top of a thread whose CLI Myrel picked among the ones the person offered. */
export function ThreadCliNote({ thread }: { thread: Thread }) {
  const t = useT();
  const cli = thread.cli;
  if (!cli || cli.by !== "coordinator") return null;
  return (
    <div className="flex gap-2.5 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-[13px]">
      <Sparkles size={15} className="mt-0.5 flex-none text-accent" aria-hidden="true" />
      <p className="min-w-0 text-body">
        {t("cliPicker.picked", { cli: cliName(cli.id), options: cli.options.map(cliName).join(", ") })}
        {cli.reason && <span className="block text-subtle">{cli.reason}</span>}
      </p>
    </div>
  );
}

/** Under a person's ask in the project chat: the CLIs they offered for it. */
export function OfferedClis({ clis }: { clis: string[] }) {
  const t = useT();
  return (
    <p className="flex items-center gap-1.5 text-xs text-subtle">
      <SquareTerminal size={13} aria-hidden="true" />
      {clis.length === 1 ? cliName(clis[0]!) : t("cliPicker.offered", { clis: clis.map(cliName).join(", ") })}
    </p>
  );
}

const triggerClass =
  "flex h-8 max-w-[11rem] flex-none items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg";

function Trigger({ label, active, several }: { label: string; active: boolean; several: boolean }) {
  return (
    <>
      {several ? (
        <Sparkles size={14} className="flex-none text-accent" aria-hidden="true" />
      ) : (
        <SquareTerminal size={14} className={cn("flex-none", active && "text-accent")} aria-hidden="true" />
      )}
      <span className={cn("truncate", active && "text-fg")}>{label}</span>
      <ChevronDown size={12} className="flex-none text-subtle" aria-hidden="true" />
    </>
  );
}

function Option({
  role,
  checked,
  onSelect,
  title,
  note,
}: {
  role: "menuitemradio" | "menuitemcheckbox";
  checked: boolean;
  onSelect: () => void;
  title: string;
  note?: ReactNode;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      onClick={onSelect}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-body hover:bg-hover hover:text-fg"
    >
      <span
        className={cn(
          "flex size-4 flex-none items-center justify-center border",
          role === "menuitemradio" ? "rounded-full" : "rounded",
          checked ? "border-accent bg-accent text-ground" : "border-edge",
        )}
        aria-hidden="true"
      >
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {note && <span className="flex-none text-xs text-subtle">{note}</span>}
    </button>
  );
}

function limitNote(cli: RunnerCli, t: ReturnType<typeof useT>): string | undefined {
  if (cli.limits?.status === "limited") return t("cliPicker.limited");
  if (cli.limits?.status === "warning") return t("cliPicker.nearLimit");
  return undefined;
}
