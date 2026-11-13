import { liveThreadGroups, type LiveThreadRow, type RecentThread } from "@myrel/client";
import type { LiveThread, Project } from "@myrel/protocol";
import { useT } from "@myrel/i18n/react";
import { Link } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, CircleDashed, CirclePause, LoaderCircle, MessageSquareText } from "lucide-react";
import { useState } from "react";
import { cn, useRelativeTime } from "../lib/ui";
import { ProjectBadge } from "./project-badge";

/** Rows a group shows before "N more". */
const GROUP_ROWS = 4;

/** Threads across the person's projects that are at work or wait on them. */
export function LiveThreads({ projects }: { projects: Project[] }) {
  const t = useT();
  const { waiting, working } = liveThreadGroups(projects);
  const total = waiting.length + working.length;
  return (
    <section aria-labelledby="live" className="flex flex-col gap-3">
      <h2 id="live" className="flex h-8 items-center justify-between text-[15px] font-semibold">
        {t("projects.live")}
        {total > 0 && <span className="font-mono text-xs font-normal text-subtle">{total}</span>}
      </h2>
      {total === 0 ? (
        <p className="rounded-xl border border-line bg-raised px-3.5 py-3 text-[13px] text-subtle">{t("projects.liveEmpty")}</p>
      ) : (
        <div className="flex flex-col gap-1 rounded-xl border border-line bg-raised p-1">
          <Group title={t("status.reviewReady")} tone="text-warn" rows={waiting} />
          <Group title={t("status.working")} tone="text-subtle" rows={working} />
        </div>
      )}
    </section>
  );
}

/** The threads that last finished or answered. Comes from the person's notifications; opening one does not mark it read. */
export function RecentThreads({ rows, className }: { rows: RecentThread[]; className?: string }) {
  const t = useT();
  const relativeTime = useRelativeTime();
  if (rows.length === 0) return null;
  return (
    <section aria-label={t("projects.recent")} className={cn("flex-col gap-3", className ?? "flex")}>
      <h2 className="flex h-8 items-center text-[15px] font-semibold">{t("projects.recent")}</h2>
      <ul className="flex flex-col rounded-xl border border-line bg-raised p-1">
        {rows.map(({ project, notification: n }) => (
          <li key={n.id}>
            <Link
              to="/projects/$projectId/threads/$threadId"
              params={{ projectId: project.id, threadId: n.threadId! }}
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
            >
              {n.kind === "done" ? (
                <CircleCheck size={15} aria-hidden="true" className="flex-none text-ok" />
              ) : (
                <MessageSquareText size={15} aria-hidden="true" className="flex-none text-accent" />
              )}
              <ProjectBadge name={project.name} icon={project.icon} color={project.color} size={22} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium text-fg">{n.title}</span>
                <span className="flex min-w-0 gap-2 text-xs text-subtle">
                  <span className="max-w-[45%] flex-none truncate">{project.name}</span>
                  <span className="truncate">{n.kind === "done" ? t("status.done") : t("status.replied")}</span>
                </span>
              </span>
              <time dateTime={n.createdAt} className="flex-none text-xs tabular-nums text-subtle">
                {relativeTime(n.createdAt)}
              </time>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Group({ title, tone, rows }: { title: string; tone: string; rows: LiveThreadRow[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  const shown = open ? rows : rows.slice(0, GROUP_ROWS);
  const hidden = rows.length - shown.length;
  return (
    <div>
      <h3 className={`px-2.5 pb-1 pt-2 text-xs font-normal ${tone}`}>{title}</h3>
      <ul className="flex flex-col">
        {shown.map((row) => (
          <li key={row.thread.id}>
            <Row {...row} />
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" onClick={() => setOpen(true)} className="rounded-md px-2.5 py-1.5 text-xs text-link hover:underline">
          {t("projects.liveMore", { count: hidden })}
        </button>
      )}
    </div>
  );
}

function Row({ project, thread }: LiveThreadRow) {
  const relativeTime = useRelativeTime();
  return (
    <Link
      to="/projects/$projectId/threads/$threadId"
      params={{ projectId: project.id, threadId: thread.id }}
      className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent"
    >
      <StateIcon state={thread.state} />
      <ProjectBadge name={project.name} icon={project.icon} color={project.color} size={22} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-fg">{thread.title}</span>
        <span className="flex min-w-0 gap-2 text-xs text-subtle">
          <span className="max-w-[45%] flex-none truncate">{project.name}</span>
          <StateLabel thread={thread} />
        </span>
      </span>
      <time dateTime={thread.updatedAt} className="flex-none text-xs tabular-nums text-subtle">
        {relativeTime(thread.updatedAt)}
      </time>
    </Link>
  );
}

function StateIcon({ state }: { state: LiveThread["state"] }) {
  const props = { size: 15, "aria-hidden": true } as const;
  switch (state) {
    case "working":
      return <LoaderCircle {...props} className="flex-none animate-spin text-accent motion-reduce:animate-none" />;
    case "queued":
      return <CircleDashed {...props} className="flex-none text-subtle" />;
    case "waiting":
      return <CirclePause {...props} className="flex-none text-warn" />;
    case "failed":
      return <CircleAlert {...props} className="flex-none text-bad" />;
  }
}

/** What the row's thread is up to: the plan's step at work, what it asks when waiting. */
function StateLabel({ thread }: { thread: LiveThread }) {
  const t = useT();
  if (thread.state === "failed") return <span className="truncate text-bad">{t("status.failed")}</span>;
  if (thread.state === "queued") return <span className="truncate">{t("projects.liveQueued")}</span>;
  if (thread.state === "waiting") {
    const label = thread.needs === "decision" ? t("projects.liveDecision") : thread.needs === "review" ? t("projects.liveReview") : t("status.reviewReady");
    return <span className="truncate">{label}</span>;
  }
  return (
    <>
      <span className="truncate">{thread.step ?? t("status.working")}</span>
      {thread.progress && <span className="flex-none tabular-nums">{thread.progress}</span>}
    </>
  );
}
