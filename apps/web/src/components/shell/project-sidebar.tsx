import type { SocketStatus } from "@altair/client";
import type { Translate } from "@altair/i18n";
import { useT } from "@altair/i18n/react";
import type { Thread } from "@altair/protocol";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, ChevronRight, ChevronsUpDown, Hash, Plus, Search, Settings, SquarePen, Wifi, WifiOff } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { projectsQuery } from "../../lib/api";
import { useProjectContext } from "../../lib/project-context";
import { cn, Kbd, useRelativeTime } from "../../lib/ui";
import { threadActivity, ThreadStatusIcon } from "../chat/thread-status";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../ui/menu";
import { Sidebar } from "./shell";

/** The project's sidebar: project switcher, search, project chat, threads, connection. */
export function ProjectSidebar({ footer }: { footer?: ReactNode }) {
  const t = useT();
  const { project, members, state, status } = useProjectContext();
  const [query, setQuery] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl+K jumps to thread search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { open, resolved } = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const all = Object.values(state.threads)
      .filter((t) => !q || t.title.toLocaleLowerCase().includes(q))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { open: all.filter((t) => !t.resolved), resolved: all.filter((t) => t.resolved) };
  }, [state.threads, query]);

  return (
    <Sidebar label={t("sidebar.label")}>
      <div className="flex flex-col gap-3 px-3.5 pb-2.5 pt-3.5">
        <ProjectSwitcher current={project.id} name={project.name} memberCount={members.length} />
        <div className="flex gap-2">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#26262b] bg-[#19191d] px-2.5 text-subtle focus-within:border-edge">
            <Search size={15} aria-hidden="true" />
            <input
              ref={search}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("sidebar.searchThreads")}
              aria-label={t("sidebar.searchThreads")}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-subtle"
            />
            <span className="hidden md:inline">
              <Kbd>⌘K</Kbd>
            </span>
          </label>
          <Link
            to="/projects/$projectId"
            params={{ projectId: project.id }}
            aria-label={t("sidebar.newRequest")}
            title={t("sidebar.newRequest")}
            className="flex size-9 flex-none items-center justify-center rounded-lg border border-[#26262b] bg-[#19191d] text-fg hover:bg-hover"
          >
            <SquarePen size={16} />
          </Link>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <div className="px-2 py-1">
          <Link
            to="/projects/$projectId"
            params={{ projectId: project.id }}
            activeOptions={{ exact: true }}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-muted hover:bg-hover hover:text-fg"
            activeProps={{ className: "bg-hover !text-fg font-medium" }}
          >
            <Hash size={16} aria-hidden="true" />
            {t("sidebar.projectChat")}
          </Link>
        </div>

        <div className="px-2 pt-3.5">
          <div className="flex items-center px-2.5 pb-1.5 text-xs text-subtle">
            {t("sidebar.threads")}
            <span className="ml-auto font-mono">{open.length}</span>
          </div>
          {open.length === 0 && (
            <p className="px-2.5 py-2 text-[13px] text-subtle">
              {query ? t("sidebar.noMatch") : t("sidebar.noThreads")}
            </p>
          )}
          <ul className="flex flex-col gap-0.5">
            {open.map((t) => (
              <li key={t.id}>
                <ThreadRow projectId={project.id} thread={t} />
              </li>
            ))}
          </ul>

          {resolved.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowResolved((s) => !s)}
                aria-expanded={showResolved}
                className="mt-3 flex w-full items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-subtle hover:text-fg"
              >
                {showResolved ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                {t("sidebar.resolved")}
                <span className="ml-auto font-mono">{resolved.length}</span>
              </button>
              {showResolved && (
                <ul className="flex flex-col gap-0.5">
                  {resolved.map((t) => (
                    <li key={t.id}>
                      <ThreadRow projectId={project.id} thread={t} />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>

      {footer ?? <ConnectionCard status={status} />}
    </Sidebar>
  );
}

function ThreadRow({ projectId, thread }: { projectId: string; thread: Thread }) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const activity = threadActivity(thread, t);
  return (
    <Link
      to="/projects/$projectId/threads/$threadId"
      params={{ projectId, threadId: thread.id }}
      className={cn(
        "flex items-start gap-2.5 rounded-lg px-2.5 py-2 hover:bg-hover",
        thread.resolved ? "text-muted" : "text-fg",
      )}
      activeProps={{ className: "bg-hover" }}
    >
      <span className="mt-0.5">
        <ThreadStatusIcon thread={thread} size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate", !thread.resolved && "font-medium")}>{thread.title}</span>
        <span className={cn("truncate text-xs", activity.tone)}>{activity.label}</span>
      </span>
      <time dateTime={thread.updatedAt} className="mt-0.5 flex-none text-[11px] text-subtle">
        {relativeTime(thread.updatedAt)}
      </time>
    </Link>
  );
}

function ProjectSwitcher({ current, name, memberCount }: { current: string; name: string; memberCount: number }) {
  const { data: projects = [] } = useQuery(projectsQuery);
  const navigate = useNavigate();
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
            <span className="text-xs text-subtle">{t("sidebar.members", { count: memberCount })}</span>
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
                  void navigate({ to: "/projects/$projectId", params: { projectId: p.id } });
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
              void navigate({ to: "/settings/projects/$projectId", params: { projectId: current } });
            }}
          >
            Project settings
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

const CONNECTION: Record<SocketStatus, (t: Translate) => { label: string; detail: string; dot: string }> = {
  open: (t) => ({
    label: t("connection.open"),
    detail: t("connection.openDetail"),
    dot: "bg-ok shadow-[0_0_0_3px_rgba(79,203,141,0.18)]",
  }),
  connecting: (t) => ({ label: t("connection.connecting"), detail: t("connection.connectingDetail"), dot: "bg-warn" }),
  closed: (t) => ({ label: t("connection.closed"), detail: t("connection.closedDetail"), dot: "bg-bad" }),
};

function ConnectionCard({ status }: { status: SocketStatus }) {
  const t = useT();
  const c = (CONNECTION[status] ?? CONNECTION.connecting)(t);
  return (
    <div className="mx-3 mb-3.5 flex items-center gap-2.5 rounded-[10px] border border-[#26262b] bg-[#16161a] px-3 py-2.5">
      {status === "closed" ? (
        <WifiOff size={16} className="flex-none text-bad" aria-hidden="true" />
      ) : (
        <Wifi size={16} className="flex-none text-muted" aria-hidden="true" />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] font-medium">{c.label}</span>
        <span className="truncate text-xs text-subtle">{c.detail}</span>
      </span>
      <span aria-hidden="true" className={cn("ml-auto size-2 flex-none rounded-full", c.dot)} />
    </div>
  );
}
