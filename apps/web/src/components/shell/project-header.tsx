import { type SocketStatus, workingCount } from "@myrel/client";
import type { MessageKey, Translate } from "@myrel/i18n";
import type { ProjectColor, ProjectIcon } from "@myrel/protocol";
import { useT } from "@myrel/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BarChart3, Blocks, Check, ChevronsUpDown, FolderOpen, List, MessageSquareText, Plus, Settings, WifiOff } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { projectsQuery } from "../../lib/api";
import { useProjectContext } from "../../lib/project-context";
import { cn, IconButton } from "../../lib/ui";
import { WorkspaceButton } from "../local-folder";
import { ProjectBadge } from "../project-badge";
import { PinButton } from "../project-pin";
import { useOpenProjectSettings } from "../project-settings-dialog";
import { type ProjectView, useProjectView, viewSearch } from "../project-view";
import { RoutinesButton, RoutinesPanel } from "../routines";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../ui/menu";
import { NavToggle } from "./shell";

/** The id of the area the project tabs control. */
export const PROJECT_TABPANEL = "project-tabpanel";

const TABS: { id: ProjectView; label: MessageKey; icon: typeof List }[] = [
  { id: "chat", label: "tabs.chat", icon: MessageSquareText },
  { id: "threads", label: "sidebar.threads", icon: List },
  { id: "artifacts", label: "sidebar.artifacts", icon: Blocks },
  { id: "files", label: "tabs.files", icon: FolderOpen },
  { id: "usage", label: "tabs.usage", icon: BarChart3 },
];

/** A project's top bar: project switcher, the tabs (conversation first), local folder and settings. */
export function ProjectHeader() {
  const t = useT();
  const { project, members, state, status } = useProjectContext();
  const { view, go } = useProjectView();
  const openSettings = useOpenProjectSettings();
  const tabs = useRef<HTMLDivElement>(null);
  const routines = Object.values(state.routines);
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const counts: Partial<Record<ProjectView, number>> = {
    threads: Object.values(state.threads).filter((th) => !th.resolved).length,
    artifacts: Object.keys(state.artifacts).length,
  };

  // ⌘K / Ctrl+K opens the threads tab, whose search takes focus.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        go("threads");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  // Arrow keys move between tabs, as in any tab list.
  function onTabKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(TABS.findIndex((tab) => tab.id === view) + step + TABS.length) % TABS.length]!;
    go(next.id);
    tabs.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  }

  return (
    <header className="@container flex h-14 flex-none items-center gap-2 border-b border-line px-3 sm:gap-3 sm:px-4">
      <NavToggle />
      <div className="min-w-0 max-w-[240px] flex-initial">
        <ProjectSwitcher
          current={project.id}
          name={project.name}
          icon={project.icon}
          color={project.color}
          memberCount={members.length}
          working={workingCount(state)}
        />
      </div>
      <div
        ref={tabs}
        role="tablist"
        aria-label={t("tabs.label")}
        onKeyDown={onTabKey}
        className="flex flex-none items-center gap-0.5 rounded-[10px] border border-card bg-well p-[3px]"
      >
        {TABS.map((tab) => {
          const selected = tab.id === view;
          const count = counts[tab.id];
          const label = t(tab.label);
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-tab={tab.id}
              aria-selected={selected}
              aria-controls={PROJECT_TABPANEL}
              tabIndex={selected ? 0 : -1}
              title={label}
              onClick={() => go(tab.id)}
              className={cn(
                "flex h-[30px] items-center gap-[7px] rounded-[7px] px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent",
                tab.id === "chat"
                  ? cn(
                      // The conversation is where work starts: it leads and stands apart.
                      "mr-1.5 font-semibold",
                      selected
                        ? "bg-tab text-tab-fg shadow-[inset_0_0_0_1px_var(--color-tab-ring)]"
                        : "text-link hover:bg-accent-soft",
                    )
                  : selected
                    ? "bg-selected font-medium text-fg"
                    : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <tab.icon size={15} strokeWidth={1.9} aria-hidden="true" />
              {/* Only the selected tab spells out its name; the others are icons with a tooltip. */}
              <span className={selected ? "@max-[560px]:sr-only" : "sr-only"}>{label}</span>
              {count ? <span className="font-mono text-[11px] text-subtle @max-[560px]:hidden">{count}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="ml-auto flex flex-none items-center gap-1.5">
        <ConnectionBadge status={status} />
        <div className="whitespace-nowrap max-md:hidden">
          <WorkspaceButton project={project} />
        </div>
        <RoutinesButton
          onClick={() => setRoutinesOpen(true)}
          count={routines.length}
          className="flex size-9 flex-none items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
        />
        <IconButton
          type="button"
          onClick={() => openSettings()}
          aria-label={t("chat.projectSettings")}
          title={t("chat.projectSettings")}
          className="-mr-1 size-9 flex-none"
        >
          <Settings size={16} />
        </IconButton>
      </div>
      {routinesOpen && (
        <RoutinesPanel
          projectId={project.id}
          routines={routines}
          threads={Object.values(state.threads)}
          onClose={() => setRoutinesOpen(false)}
        />
      )}
    </header>
  );
}

function ProjectSwitcher({
  current,
  name,
  icon,
  color,
  memberCount,
  working,
}: {
  current: string;
  name: string;
  icon?: ProjectIcon | null;
  color?: ProjectColor | null;
  memberCount: number;
  /** The open project's working count, live from its socket; the list's is only as fresh as its last fetch. */
  working: number;
}) {
  const navigate = useNavigate();
  const openSettings = useOpenProjectSettings();
  const t = useT();
  return (
    <Menu
      label={t("sidebar.switchProject")}
      className="flex w-full items-center gap-2.5 rounded-lg px-1 py-1.5 text-left hover:bg-hover"
      panelClassName="w-[248px]"
      trigger={
        <>
          <ProjectBadge name={name} icon={icon} color={color} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-semibold">{name}</span>
            <span className="text-xs text-subtle @max-[760px]:hidden">{t("sidebar.members", { count: memberCount })}</span>
          </span>
          <ChevronsUpDown size={15} className="flex-none text-subtle" aria-hidden="true" />
        </>
      }
    >
      {(close) => (
        <>
          <MenuLabel>{t("projects.title")}</MenuLabel>
          <ProjectList
            current={current}
            working={working}
            onSelect={(projectId) => {
              close();
              void navigate({ to: "/projects/$projectId", params: { projectId }, search: viewSearch("chat") });
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={<Settings size={15} />}
            onSelect={() => {
              close();
              openSettings();
            }}
          >
            {t("chat.projectSettings")}
          </MenuItem>
          <MenuItem
            icon={<Plus size={15} />}
            onSelect={() => {
              close();
              void navigate({ to: "/" });
            }}
          >
            {t("sidebar.newProject")}
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

/**
 * The switcher's projects, each with how many agents work in it. Mounted only while the menu is open,
 * so it fetches fresh counts on opening and polls like the project list, without polling in the background.
 * Pinned projects come first, in the server's order; each row has its own pin toggle.
 */
function ProjectList({ current, working, onSelect }: { current: string; working: number; onSelect: (projectId: string) => void }) {
  const t = useT();
  const { data: projects = [] } = useQuery({ ...projectsQuery, refetchOnMount: "always", refetchInterval: 15_000 });
  return (
    <div className="max-h-72 overflow-y-auto">
      {projects.map((p) => (
        <div key={p.id} className="group relative">
          <MenuItem icon={<ProjectBadge name={p.name} icon={p.icon} color={p.color} size={22} />} onSelect={() => onSelect(p.id)} className="pr-10">
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <WorkingBadge count={p.id === current ? working : (p.activity?.working ?? 0)} />
            {p.id === current && <Check size={14} className="flex-none text-accent" aria-label={t("sidebar.current")} />}
          </MenuItem>
          <PinButton project={p} className="absolute right-1.5 top-1/2 -translate-y-1/2" />
        </div>
      ))}
    </div>
  );
}

/** "2 working", small and quiet beside a project's name; nothing when no agent works there. */
function WorkingBadge({ count }: { count: number }) {
  const t = useT();
  if (count <= 0) return null;
  return (
    <span className="flex flex-none items-center gap-1 whitespace-nowrap rounded-full bg-accent-soft px-1.5 py-px text-[11px] tabular-nums text-link">
      <span className="size-1.5 flex-none animate-pulse rounded-full bg-accent" aria-hidden="true" />
      {t("sidebar.working", { count })}
    </span>
  );
}

const CONNECTION: Record<Exclude<SocketStatus, "open">, (t: Translate) => { label: string; detail: string; dot: string }> = {
  connecting: (t) => ({ label: t("connection.connecting"), detail: t("connection.connectingDetail"), dot: "bg-warn" }),
  closed: (t) => ({ label: t("connection.closed"), detail: t("connection.closedDetail"), dot: "bg-bad" }),
};

/** How long the connection may be down or coming up before the badge says so. */
const CONNECTION_GRACE_MS = 2_000;

/**
 * Shown only while the live connection has been down, or still coming up, for
 * a moment: a normal connect or a quick reconnect never flashes it.
 */
function ConnectionBadge({ status }: { status: SocketStatus }) {
  const t = useT();
  const down = status !== "open";
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!down) return setLate(false);
    const timer = setTimeout(() => setLate(true), CONNECTION_GRACE_MS);
    return () => clearTimeout(timer);
  }, [down]);
  if (!down || !late) return null;
  const c = (CONNECTION[status] ?? CONNECTION.connecting)(t);
  return (
    <span
      role="status"
      title={c.detail}
      className="flex h-7 flex-none items-center gap-1.5 rounded-full border border-card bg-well px-2.5 text-xs text-muted"
    >
      {status === "closed" ? (
        <WifiOff size={13} className="text-bad" aria-hidden="true" />
      ) : (
        <span aria-hidden="true" className={cn("size-2 rounded-full", c.dot)} />
      )}
      <span className="@max-[640px]:sr-only">{c.label}</span>
    </span>
  );
}

