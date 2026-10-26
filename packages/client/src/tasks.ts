import type { Task, TerminalLine } from "@myrel/protocol";

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

/** A subagent of a task, as its terminal lines tell it (see LineAgent). */
export type SubagentSummary = {
  id: string;
  label: string;
  /** What it is for, from its starting line. */
  purpose: string;
  status: "running" | "done" | "failed" | "stopped";
  /** When its first line arrived (epoch ms), when known. */
  startedAt?: number;
  /** How long it ran, once it ended. */
  ms?: number;
  /** Its tool calls seen in the terminal. */
  steps: number;
  /** Its latest step. */
  lastStep?: string;
  /** Its answer, from its ending line. */
  answer: string;
  model?: string;
  tokens?: number;
};

/**
 * The subagents in a task's terminal lines, in the order they started. One whose task is no longer
 * running and that never ended counts as stopped; one whose starting line fell out of the kept lines
 * still shows, without its purpose.
 */
export function taskSubagents(lines: TerminalLine[], running: boolean): SubagentSummary[] {
  const byId = new Map<string, SubagentSummary>();
  for (const line of lines) {
    const tag = line.agent;
    if (!tag) continue;
    let agent = byId.get(tag.id);
    if (!agent) {
      agent = { id: tag.id, label: tag.label, purpose: "", status: "running", steps: 0, answer: "", ...(line.at !== undefined && { startedAt: line.at }) };
      byId.set(tag.id, agent);
    }
    if (tag.state === "started") agent.purpose = line.text;
    else if (tag.state === "done" || tag.state === "failed") {
      agent.status = tag.state;
      agent.answer = line.text;
      if (line.ms !== undefined) agent.ms = line.ms;
      if (tag.model) agent.model = tag.model;
      if (tag.tokens !== undefined) agent.tokens = tag.tokens;
    } else if (line.tool) {
      agent.steps++;
      agent.lastStep = line.text.replace(/^→ /, "");
    }
  }
  const list = [...byId.values()];
  if (!running) for (const a of list) if (a.status === "running") a.status = "stopped";
  return list;
}
