import type { LiveThread, Project } from "@myrel/protocol";

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
