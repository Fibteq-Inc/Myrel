import type { MessageKey } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import {
  CLI_NAMES,
  CLOUD_RUNNER,
  type CliId,
  type CliModelDefaults,
  CloudCli,
  EFFORT_LEVELS,
  effortsFor,
  type Project,
  type ProjectWorkspace,
  type PromptSize,
  type RunnerCli,
  type Thread,
} from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Cloud, Lock, SlidersHorizontal, Sparkles, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { projectSettingsQuery, runnersQuery, workspaceQuery, workspacesQuery } from "../../lib/api";
import { cn } from "../../lib/ui";
import { Menu, MenuLabel, MenuSeparator } from "../ui/menu";
import { ContextRing, ContextSection } from "./context-gauge";

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

/** `runnerId`: the computer the thread works on, when it was set to or started on one, or CLOUD_RUNNER. */
export function usePickableClis(project: Project, runnerId?: string | null): PickableClis | null {
  const { data: default_, isPending } = useQuery(workspaceQuery(project.id));
  const { data: runners } = useQuery({ ...runnersQuery, enabled: !!default_ });
  const { data: settings } = useQuery(projectSettingsQuery(project.id));
  const own = useOwnWorkspaces(project);
  if (isPending || !settings) return null;
  if (runnerId === CLOUD_RUNNER) return { clis: CLOUD_CLIS, folderCli: settings.cloudCli, defaults: {}, cloud: true };
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

/** An effort level's name, e.g. "xhigh" as "Extra high"; one Myrel does not know shows as the CLI wrote it. */
export function effortName(effort: string, t: ReturnType<typeof useT>): string {
  return (EFFORT_LEVELS as readonly string[]).includes(effort) ? t(`modelPicker.effort.${effort}` as MessageKey) : effort;
}

/**
 * The model and effort a thread's CLI runs with from its next turn: the thread's own pick, else the
 * project's default for that CLI, else the CLI's. Only for a local CLI that lists its models; efforts
 * only those the model takes.
 */
function modelChoice(pickable: PickableClis, thread: Thread) {
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
  const projectModel = project?.model ? (models.find((m) => m.id === project.model)?.name ?? project.model) : null;
  const next = (change: { model?: string | null; effort?: string | null }) => {
    const m = change.model !== undefined ? change.model : (own?.model ?? null);
    let e = change.effort !== undefined ? change.effort : (own?.effort ?? null);
    // An effort the new model does not take would be dropped anyway: say so by clearing it.
    if (e && !effortsFor(models, m ?? project?.model ?? null).includes(e)) e = null;
    return { cli, model: m, effort: e };
  };
  return { cli, models, own, model, efforts, effort, projectModel, next };
}

/**
 * The composer control in a thread: one button summing up where it works, its CLI, model and effort,
 * opening one panel to change any of them from its next turn. The panel stays open across picks, so
 * a new CLI's model can be picked right after. Someone who can pick nothing sees it read-only.
 * After the agent's first turn it also shows how full that turn's prompt was.
 */
export function ThreadSettingsPicker({
  project,
  pickable,
  workspaces,
  placeable,
  thread,
  prompt,
  onRunner,
  onCli,
  onModel,
}: {
  project: Project;
  pickable: PickableClis | null;
  /** The person's own computers in the project, the default first. */
  workspaces: ProjectWorkspace[];
  /** The project does not always work in the cloud, so a thread can be moved. */
  placeable: boolean;
  thread: Thread;
  /** What the agent's prompt held on its last turn, once it had one. */
  prompt?: PromptSize | null;
  onRunner: (runnerId: string | null) => void;
  onCli: (cli: CliId | null) => void;
  onModel: (pick: { cli: CliId; model: string | null; effort: string | null }) => void;
}) {
  const t = useT();
  const { data: folder } = useQuery(workspaceQuery(project.id));
  const { data: all = [] } = useQuery({ ...workspacesQuery(project.id), enabled: !!folder });
  const { data: runners } = useQuery({ ...runnersQuery, enabled: !!folder });
  const { data: settings } = useQuery(projectSettingsQuery(project.id));
  const cloud = thread.runner?.id === CLOUD_RUNNER;
  if (!pickable) {
    // Nothing to pick, e.g. a thread working on another member's computer: say what it runs with.
    // Not while what decides it still loads, or it would flash.
    if (!folder || !runners || !settings) return null;
    const computer = all.find((w) => w.runnerId === thread.runner?.id) ?? folder;
    const cli = thread.cli?.id ?? computer.cli;
    const own = thread.model?.cli === cli ? thread.model : null;
    const label = [cliName(cli), own?.model, own?.effort && effortName(own.effort, t)].filter(Boolean).join(" · ");
    return (
      <Menu label={t("threadSettings.title")} side="top" trigger={<SettingsTrigger label={label} active={false} prompt={prompt} />} className={triggerClass} panelClassName="w-80">
        {() => (
          <div className="px-1 pb-1">
            <MenuLabel>{t("threadSettings.where")}</MenuLabel>
            <Locked>{computer.runnerName}</Locked>
            <MenuLabel>{t("threadSettings.cli")}</MenuLabel>
            <Locked>{cliName(cli)}</Locked>
            {own?.model && (
              <>
                <MenuLabel>{t("threadSettings.model")}</MenuLabel>
                <Locked>{[own.model, own.effort && effortName(own.effort, t)].filter(Boolean).join(" · ")}</Locked>
              </>
            )}
            <p className="px-2.5 pb-1.5 pt-2 text-xs leading-relaxed text-subtle">{t("threadSettings.readOnly")}</p>
            {prompt && <ContextSection prompt={prompt} />}
          </div>
        )}
      </Menu>
    );
  }

  // Where it works: the cloud or one of the person's computers in the project, for someone with the
  // project on one of theirs (else their turns work in the cloud anyway).
  const showRunner = placeable && (workspaces.length > 0 || cloud);
  // The coordinator's cloud counts as picked too: the default sends the thread back to a computer.
  const pickedRunner = thread.runner && thread.runner.by !== "auto" ? thread.runner.id : null;
  const computer = workspaces.find((w) => w.runnerId === thread.runner?.id) ?? workspaces[0];
  const currentCli = thread.cli?.id;
  const choice = modelChoice(pickable, thread);
  const active = !!pickedRunner || !!currentCli || !!choice?.own;
  const where = cloud ? t("runnerPicker.cloud") : showRunner && computer && computer !== workspaces[0] ? computer.runnerName : null;
  const label = [
    where,
    cliName(currentCli ?? pickable.folderCli),
    choice?.model?.name,
    choice?.effort && effortName(choice.effort, t),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Menu
      label={t("threadSettings.title")}
      side="top"
      trigger={<SettingsTrigger label={label} active={active} several={thread.cli?.by === "coordinator"} cloud={cloud} prompt={prompt} />}
      className={triggerClass}
      panelClassName="w-80 max-h-[min(34rem,75vh)] overflow-y-auto"
    >
      {() => (
        <div className="px-1 pb-1">
          {showRunner && (
            <>
              <MenuLabel>{t("threadSettings.where")}</MenuLabel>
              <Pills>
                <Pill
                  checked={!pickedRunner}
                  onSelect={() => pickedRunner && onRunner(null)}
                  label={
                    thread.runner?.by === "auto" && computer
                      ? t("runnerPicker.started", { computer: computer.runnerName })
                      : workspaces[0]
                        ? t("cliPicker.default", { cli: workspaces[0].runnerName })
                        : t("runnerPicker.auto")
                  }
                />
                <Pill checked={cloud} onSelect={() => !cloud && onRunner(CLOUD_RUNNER)} label={t("runnerPicker.cloud")} />
                {workspaces.map((w) => (
                  <Pill
                    key={w.runnerId}
                    checked={pickedRunner === w.runnerId}
                    onSelect={() => pickedRunner !== w.runnerId && onRunner(w.runnerId)}
                    label={w.online ? w.runnerName : `${w.runnerName} (${t("localFolder.offline")})`}
                  />
                ))}
              </Pills>
              <MenuSeparator />
            </>
          )}
          <MenuLabel>{t("threadSettings.cli")}</MenuLabel>
          <Pills>
            <Pill checked={!currentCli} onSelect={() => currentCli && onCli(null)} label={t("cliPicker.default", { cli: cliName(pickable.folderCli) })} />
            {pickable.clis.map((c) => {
              const note = limitNote(c, t);
              return (
                <Pill
                  key={c.id}
                  checked={currentCli === c.id}
                  onSelect={() => currentCli !== c.id && onCli(c.id)}
                  label={note ? `${cliName(c.id)} (${note})` : cliName(c.id)}
                />
              );
            })}
          </Pills>
          <MenuSeparator />
          {pickable.cloud ? (
            <>
              <MenuLabel>{t("threadSettings.model")}</MenuLabel>
              <Locked>{t("threadSettings.cloudModel")}</Locked>
            </>
          ) : choice ? (
            <>
              <MenuLabel>{t("threadSettings.model")}</MenuLabel>
              <Option
                role="menuitemradio"
                checked={!choice.own?.model}
                onSelect={() => onModel(choice.next({ model: null }))}
                title={choice.projectModel ? t("modelPicker.projectDefault", { model: choice.projectModel }) : t("modelPicker.cliDefault")}
              />
              {choice.models.map((m) => (
                <Option
                  key={m.id}
                  role="menuitemradio"
                  checked={choice.own?.model === m.id}
                  onSelect={() => onModel(choice.next({ model: m.id }))}
                  title={m.name}
                />
              ))}
              <MenuSeparator />
              <MenuLabel>{t("modelPicker.effort")}</MenuLabel>
              {choice.efforts.length > 0 ? (
                <Pills>
                  <Pill checked={!choice.own?.effort} onSelect={() => onModel(choice.next({ effort: null }))} label={t("modelPicker.effortDefault")} />
                  {choice.efforts.map((e) => (
                    <Pill key={e} checked={choice.own?.effort === e} onSelect={() => onModel(choice.next({ effort: e }))} label={effortName(e, t)} />
                  ))}
                </Pills>
              ) : (
                <p className="px-2.5 pb-1.5 pt-1 text-xs leading-relaxed text-subtle">{t("modelPicker.noEffort")}</p>
              )}
            </>
          ) : (
            <>
              <MenuLabel>{t("threadSettings.model")}</MenuLabel>
              <p className="px-2.5 pb-1.5 pt-1 text-xs leading-relaxed text-subtle">{t("threadSettings.noModels")}</p>
            </>
          )}
          <p className="px-2.5 pb-1.5 pt-2 text-xs leading-relaxed text-subtle">
            {showRunner && cloud ? t("runnerPicker.hint") : t("cliPicker.threadHint")}
            {pickable.cloud && ` ${t("cliPicker.cloudHint")}`}
          </p>
          {prompt && <ContextSection prompt={prompt} />}
        </div>
      )}
    </Menu>
  );
}

function SettingsTrigger({
  label,
  active,
  several,
  cloud,
  prompt,
}: {
  label: string;
  active: boolean;
  several?: boolean;
  cloud?: boolean;
  prompt?: PromptSize | null;
}) {
  const Icon = several ? Sparkles : cloud ? Cloud : SlidersHorizontal;
  return (
    <>
      {prompt && <ContextRing prompt={prompt} />}
      <Icon size={14} className={cn("flex-none", (active || several) && "text-accent")} aria-hidden="true" />
      <span className={cn("truncate", active && "text-fg")}>{label}</span>
      <ChevronDown size={12} className="flex-none text-subtle" aria-hidden="true" />
    </>
  );
}

function Pills({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-1.5 px-2.5 pb-2 pt-1">{children}</div>;
}

function Pill({ checked, onSelect, label }: { checked: boolean; onSelect: () => void; label: string }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        "max-w-full truncate rounded-full border px-2.5 py-1 text-xs",
        checked ? "border-accent bg-accent text-ground" : "border-edge text-body hover:bg-hover hover:text-fg",
      )}
    >
      {label}
    </button>
  );
}

function Locked({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 px-2.5 pb-2 pt-1 text-[13px] text-body">
      <Lock size={13} className="flex-none text-subtle" aria-hidden="true" />
      <span className="min-w-0 truncate">{children}</span>
    </p>
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

/** The line at the top of a thread Myrel opened in the cloud, saying why. */
export function ThreadRunnerNote({ thread }: { thread: Thread }) {
  const t = useT();
  const runner = thread.runner;
  if (runner?.id !== CLOUD_RUNNER || runner.by !== "coordinator") return null;
  return (
    <div className="flex gap-2.5 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-[13px]">
      <Cloud size={15} className="mt-0.5 flex-none text-accent" aria-hidden="true" />
      <p className="min-w-0 text-body">
        {t("runnerPicker.coordinator")}
        {runner.reason && <span className="block text-subtle">{runner.reason}</span>}
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
