import { threadChildren } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { Thread } from "@myrel/protocol";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Search, SquarePen } from "lucide-react";
import { useMemo, useState } from "react";
import { useProjectContext } from "../lib/project-context";
import { cn, Kbd, useRelativeTime } from "../lib/ui";
import { ChildThreads } from "./chat/thread-card";
import { threadActivity, ThreadStatusIcon } from "./chat/thread-status";
import { ProjectResearch } from "./project-research";
import { useProjectView } from "./project-view";

/** The threads tab: every thread in the project, open ones first, with search. */
export function ProjectThreads() {
  const t = useT();
  const { project, state } = useProjectContext();
  const { go, search } = useProjectView();
  const research = search.list === "research";
  const [query, setQuery] = useState("");
  const [showResolved, setShowResolved] = useState(false);

  // A visual check's evaluator is listed under the thread it checks, not on its own.
  const checks = useMemo(() => threadChildren(state), [state]);
  const { open, resolved } = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const all = Object.values(state.threads)
      .filter((th) => !th.parentId || !state.threads[th.parentId])
      .filter((th) => !q || th.title.toLocaleLowerCase().includes(q))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { open: all.filter((th) => !th.resolved), resolved: all.filter((th) => th.resolved) };
  }, [state.threads, query]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-3 py-6 sm:px-5">
        <div role="tablist" aria-label={t("sidebar.threads")} className="inline-flex self-start rounded-lg border border-edge p-0.5 text-[13px]">
          {(["threads", "research"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={research === (v === "research")}
              onClick={() => go("threads", v === "research" ? { list: "research" } : {})}
              className={cn(
                "rounded-md px-3 py-1",
                research === (v === "research") ? "bg-bubble text-fg" : "text-muted hover:text-fg",
              )}
            >
              {t(`research.view.${v}`)}
            </button>
          ))}
        </div>
        {research ? (
          <ProjectResearch projectId={project.id} />
        ) : (
          <>
          <div className="flex gap-2">
            <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-card bg-field px-3 text-subtle focus-within:border-edge">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("sidebar.searchThreads")}
                aria-label={t("sidebar.searchThreads")}
                autoFocus
                className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
              />
              <span className="hidden md:inline">
                <Kbd>⌘K</Kbd>
              </span>
            </label>
            <button
              type="button"
              onClick={() => go("chat")}
              className="flex h-10 flex-none items-center gap-2 rounded-lg border border-card bg-field px-3 text-[13px] text-fg hover:bg-hover"
            >
              <SquarePen size={15} aria-hidden="true" />
              <span className="max-sm:sr-only">{t("sidebar.newRequest")}</span>
            </button>
          </div>

          <section className="flex flex-col gap-1">
            <h2 className="flex items-center px-2.5 pb-1 text-xs font-medium text-subtle">
              {t("threads.open")}
              <span className="ml-auto font-mono">{open.length}</span>
            </h2>
            {open.length === 0 && (
              <p className="px-2.5 py-2 text-[13px] text-subtle">{query ? t("sidebar.noMatch") : t("sidebar.noThreads")}</p>
            )}
            <ul className="flex flex-col gap-0.5">
              {open.map((th) => (
                <li key={th.id}>
                  <ThreadRow projectId={project.id} thread={th} />
                  {checks.has(th.id) && <ChildThreads projectId={project.id} threads={checks.get(th.id)!} />}
                </li>
              ))}
            </ul>
          </section>

          {resolved.length > 0 && (
            <section className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => setShowResolved((s) => !s)}
                aria-expanded={showResolved}
                className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-subtle hover:text-fg"
              >
                {showResolved ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                {t("sidebar.resolved")}
                <span className="ml-auto font-mono">{resolved.length}</span>
              </button>
              {showResolved && (
                <ul className="flex flex-col gap-0.5">
                  {resolved.map((th) => (
                    <li key={th.id}>
                      <ThreadRow projectId={project.id} thread={th} />
                      {checks.has(th.id) && <ChildThreads projectId={project.id} threads={checks.get(th.id)!} />}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          </>
        )}
      </div>
    </div>
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
        "flex items-start gap-3 rounded-[10px] px-2.5 py-2.5 hover:bg-hover",
        thread.resolved ? "text-muted" : "text-fg",
      )}
      activeProps={{ className: "bg-hover" }}
    >
      <span className="mt-0.5">
        <ThreadStatusIcon thread={thread} size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("truncate", !thread.resolved && "font-medium")}>{thread.title}</span>
        <span className={cn("truncate text-xs", activity.tone)}>{activity.label}</span>
      </span>
      <time dateTime={thread.updatedAt} className="mt-0.5 flex-none text-xs text-subtle">
        {relativeTime(thread.updatedAt)}
      </time>
    </Link>
  );
}
