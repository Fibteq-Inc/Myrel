/** Where a tapped push notification leads: its `data` names a project and maybe a thread. */
export function notificationPath(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const { projectId, threadId } = data as Record<string, unknown>;
  if (typeof projectId !== "string" || !/^proj_[0-9A-Za-z]+$/.test(projectId)) return null;
  if (typeof threadId === "string" && /^thr_[0-9A-Za-z]+$/.test(threadId)) {
    return `/projects/${projectId}/threads/${threadId}`;
  }
  return `/projects/${projectId}`;
}

/**
 * How to get from the screen at `currentPath` to a notification's `path`: nothing when it is
 * already open, a push within the same project, or, for another project, back to the project
 * list first. expo-router matches the open `projects/[projectId]` route by name only, so a plain
 * push from project A to project B's thread lands in A's stack, under A's live connection, where
 * B's thread never loads.
 */
export function notificationNavigation(currentPath: string, path: string): "none" | "push" | "switch" {
  if (currentPath === path) return "none";
  const open = projectOf(currentPath);
  return open === null || open === projectOf(path) ? "push" : "switch";
}

function projectOf(path: string): string | null {
  return /^\/projects\/([^/?#]+)/.exec(path)?.[1] ?? null;
}
