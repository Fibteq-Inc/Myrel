import type { Project } from "@myrel/protocol";

/**
 * The project list with one project's pin changed, ordered the way the server orders it:
 * pinned projects first in the order they were pinned, so a new pin goes last among them,
 * then the rest newest first. For updating a cached list before the server answers.
 */
export function withProjectPinned(projects: Project[], id: string, pinned: boolean): Project[] {
  const target = projects.find((p) => p.id === id);
  if (!target) return projects;
  const others = projects.filter((p) => p.id !== id);
  const pins = others.filter((p) => p.pinned);
  const rest = others.filter((p) => !p.pinned);
  if (pinned) return [...pins, { ...target, pinned: true }, ...rest];
  const unpinned = { ...target, pinned: false };
  return [...pins, ...[...rest, unpinned].sort((a, b) => b.createdAt.localeCompare(a.createdAt))];
}
