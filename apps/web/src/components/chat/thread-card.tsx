import { useT } from "@myrel/i18n/react";
import type { Thread } from "@myrel/protocol";
import { Link } from "@tanstack/react-router";
import { ChevronRight, SquareTerminal } from "lucide-react";
import { cn } from "../../lib/ui";
import { threadActivity, ThreadStatusIcon } from "./thread-status";

/**
 * The card under a project-chat message that opened a thread: title, reply
 * count, and a live line with what the thread is doing right now.
 */
export function ThreadCard({ projectId, thread, replies }: { projectId: string; thread: Thread; replies: number }) {
  const t = useT();
  const activity = threadActivity(thread, t);
  const live = thread.status === "working" && !thread.resolved;
  return (
    <Link
      to="/projects/$projectId/threads/$threadId"
      params={{ projectId, threadId: thread.id }}
      className="group flex flex-col overflow-hidden rounded-xl border border-[#26262b] bg-raised text-fg transition-colors hover:border-edge"
      activeProps={{ className: "border-accent/60" }}
    >
      <span className="flex items-center gap-2.5 px-3.5 py-3">
        <ThreadStatusIcon thread={thread} />
        <span className="truncate font-semibold">{thread.title}</span>
        <span className="ml-auto flex-none text-xs text-subtle">
          {t("threadCard.replies", { count: replies })}
        </span>
        <ChevronRight
          size={15}
          className="flex-none text-subtle transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      </span>
      <span
        className={cn(
          "flex items-center gap-2 border-t border-[#222227] bg-panel px-3.5 py-2 text-xs",
          live ? "font-mono text-muted" : activity.tone,
        )}
      >
        {live && <SquareTerminal size={13} className="flex-none text-subtle" aria-hidden="true" />}
        <span className="truncate">{activity.label}</span>
        {live && activity.progress && <span className="ml-auto flex-none text-subtle">{activity.progress}</span>}
        {live && (
          <span
            aria-hidden="true"
            className={cn("size-1.5 flex-none animate-pulse rounded-full bg-accent", !activity.progress && "ml-auto")}
          />
        )}
      </span>
    </Link>
  );
}
