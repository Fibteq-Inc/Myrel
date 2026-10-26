import type { Task } from "@myrel/protocol";

/** A thread's tasks for its Terminal tab: the running one first, then newest to oldest by start. */
export function newestFirst(tasks: Task[]): Task[] {
  const rank = (task: Task) => (task.status === "running" ? 1 : 0);
  return [...tasks].sort((a, b) => rank(b) - rank(a) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** The first line of a task's closing words, without Markdown marks, to tell its row apart from the others. */
export function taskHeadline(summary: string | null): string | null {
  for (const raw of summary?.split("\n") ?? []) {
    const line = raw
      .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/[*_`]+/g, "")
      .trim();
    if (line) return line;
  }
  return null;
}
