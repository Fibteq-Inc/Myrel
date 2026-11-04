import type { LiveThread, Notification, Project } from "@myrel/protocol";

export type LiveThreadRow = { project: Project; thread: LiveThread };

/**
 * Open threads across the person's projects, split by who is up: a person, or an agent. Rows follow the
 * project list's own order, then each project's oldest thread first, so they keep their place as plans move.
 */
export function liveThreadGroups(projects: Project[]): { waiting: LiveThreadRow[]; working: LiveThreadRow[] } {
  const rows = projects.flatMap((project) => (project.live ?? []).map((thread) => ({ project, thread })));
  const waits = ({ thread }: LiveThreadRow) => thread.state === "waiting" || thread.state === "failed";
  return { waiting: rows.filter(waits), working: rows.filter((row) => !waits(row)) };
}

export type RecentThread = { project: Project; notification: Notification };

/** How many threads the home page lists as having last finished or answered. */
const RECENT_THREADS = 5;

/**
 * The threads that last finished or answered, newest first, from the person's notifications (which come
 * newest first): each thread once, by its latest news, and none still in progress or waiting, listed apart.
 */
export function recentThreads(notifications: Notification[], projects: Project[]): RecentThread[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const seen = new Set(projects.flatMap((p) => (p.live ?? []).map((t) => t.id as string)));
  const rows: RecentThread[] = [];
  for (const notification of notifications) {
    const project = byId.get(notification.projectId);
    if (!project || !notification.threadId || seen.has(notification.threadId)) continue;
    seen.add(notification.threadId);
    // The thread's latest news decides: one that last failed or asked something is not "recently done".
    if (notification.kind === "done" || notification.kind === "ready") rows.push({ project, notification });
    if (rows.length === RECENT_THREADS) break;
  }
  return rows;
}
