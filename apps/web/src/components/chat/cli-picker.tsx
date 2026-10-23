import { useT } from "@myrel/i18n/react";
import { CLI_NAMES, type CliId, type Project, type RunnerCli, type Thread } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Sparkles, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { projectSettingsQuery, runnersQuery, workspaceQuery } from "../../lib/api";
import { cn } from "../../lib/ui";
import { Menu, MenuLabel, MenuSeparator } from "../ui/menu";

export function cliName(id: string): string {
  return CLI_NAMES[id as CliId] ?? id;
}

/**
 * The CLIs the signed-in person can pick for this project's threads: those on the project folder's
 * computer, when that computer is theirs (a turn only runs there for its owner) and the project does
 * not always work in the cloud. Null when there is nothing to pick.
 */
export function usePickableClis(project: Project): { clis: RunnerCli[]; folderCli: CliId } | null {
  const { data: workspace } = useQuery(workspaceQuery(project.id));
  const { data: runners } = useQuery({ ...runnersQuery, enabled: !!workspace });
  const { data: settings } = useQuery({ ...projectSettingsQuery(project.id), enabled: !!workspace });
  // Only your own computers are listed, so finding it means it is yours.
  const runner = workspace && runners?.find((r) => r.id === workspace.runnerId);
  if (!workspace || !runner || runner.clis.length === 0 || settings?.taskTarget === "cloud") return null;
  return { clis: runner.clis, folderCli: workspace.cli };
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
  pickable: { clis: RunnerCli[]; folderCli: CliId };
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
  pickable: { clis: RunnerCli[]; folderCli: CliId };
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
          <p className="px-2.5 pb-1.5 pt-2 text-xs leading-relaxed text-subtle">{t("cliPicker.threadHint")}</p>
        </>
      )}
    </Menu>
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
