import type { SocketStatus } from "@altair/client";
import type { MessageKey, Translate } from "@altair/i18n";
import { useT } from "@altair/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BarChart3, Blocks, Check, ChevronsUpDown, FolderOpen, List, MessageSquareText, Plus, Settings, WifiOff } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { projectsQuery } from "../../lib/api";
import { useProjectContext } from "../../lib/project-context";
import { cn, IconButton } from "../../lib/ui";
import { WorkspaceButton } from "../local-folder";
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
        <ProjectSwitcher current={project.id} name={project.name} memberCount={members.length} />
      </div>
      <div
        ref={tabs}
        role="tablist"
        aria-label={t("tabs.label")}
        onKeyDown={onTabKey}
        className="flex flex-none items-center gap-0.5 rounded-[10px] border border-[#26262b] bg-[#131316] p-[3px]"
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
                        ? "bg-[#2b3366] text-[#dfe3ff] shadow-[inset_0_0_0_1px_#4a55a8]"
                        : "text-[#b4beff] hover:bg-accent-soft",
                    )
                  : selected
                    ? "bg-[#24242a] font-medium text-fg"
                    : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <tab.icon size={15} strokeWidth={1.9} aria-hidden="true" />
              <span className={tab.id === "chat" ? "@max-[560px]:sr-only" : "@max-[900px]:sr-only"}>{label}</span>
              {count ? <span className="font-mono text-[11px] text-subtle @max-[900px]:hidden">{count}</span> : null}
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
          onClick={openSettings}
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

function ProjectSwitcher({ current, name, memberCount }: { current: string; name: string; memberCount: number }) {
  const { data: projects = [] } = useQuery(projectsQuery);
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
          <ProjectBadge name={name} />
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
          <div className="max-h-72 overflow-y-auto">
            {projects.map((p) => (
              <MenuItem
                key={p.id}
                icon={<ProjectBadge name={p.name} size={22} />}
                onSelect={() => {
                  close();
                  void navigate({ to: "/projects/$projectId", params: { projectId: p.id }, search: viewSearch("chat") });
                }}
              >
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.id === current && <Check size={14} className="flex-none text-accent" aria-label={t("sidebar.current")} />}
              </MenuItem>
            ))}
          </div>
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

/** A project's first letter on a tinted square. */
export function ProjectBadge({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}
      className="flex flex-none items-center justify-center rounded-lg bg-accent-soft font-semibold text-[#b4beff]"
    >
      {name.trim()[0]?.toLocaleUpperCase() ?? "?"}
    </span>
  );
}

const CONNECTION: Record<Exclude<SocketStatus, "open">, (t: Translate) => { label: string; detail: string; dot: string }> = {
  connecting: (t) => ({ label: t("connection.connecting"), detail: t("connection.connectingDetail"), dot: "bg-warn" }),
  closed: (t) => ({ label: t("connection.closed"), detail: t("connection.closedDetail"), dot: "bg-bad" }),
};

/** Shown only while the live connection is down or still coming up. */
function ConnectionBadge({ status }: { status: SocketStatus }) {
  const t = useT();
  if (status === "open") return null;
  const c = (CONNECTION[status] ?? CONNECTION.connecting)(t);
  return (
    <span
      role="status"
      title={c.detail}
      className="flex h-7 flex-none items-center gap-1.5 rounded-full border border-[#26262b] bg-[#16161a] px-2.5 text-xs text-muted"
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

