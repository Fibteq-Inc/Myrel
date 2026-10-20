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
