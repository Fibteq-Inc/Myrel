import type { Phase, RunnerEvent, TodoStatus } from "./spec";

export type PhaseState = "pending" | "started" | "done" | "failed" | "skipped";

/** What a task's events add up to. Pure data, folded with `reduceTask`. */
export type TaskProgress = {
  phases: Record<Phase, PhaseState>;
  phaseDetail: Partial<Record<Phase, string>>;
  todos: { text: string; status: TodoStatus }[];
  /** The harness's last prose, used as the task's summary. */
  lastText: string | null;
  lastTool: string | null;
  prUrl: string | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  finished: null | { ok: boolean; exitCode?: number; error?: string };
};

export function emptyProgress(): TaskProgress {
  return {
    phases: { prepare: "pending", clone: "pending", agent: "pending", publish: "pending" },
    phaseDetail: {},
    todos: [],
    lastText: null,
    lastTool: null,
    prUrl: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    finished: null,
  };
}

export function reduceTask(p: TaskProgress, e: RunnerEvent): TaskProgress {
  switch (e.type) {
    case "phase":
      return {
        ...p,
        phases: { ...p.phases, [e.phase]: e.state },
        phaseDetail: e.detail ? { ...p.phaseDetail, [e.phase]: e.detail } : p.phaseDetail,
      };
    case "todos":
      return { ...p, todos: e.items };
    case "text":
      return { ...p, lastText: e.text };
    case "tool":
      return { ...p, lastTool: e.title };
    case "pr":
      return { ...p, prUrl: e.url };
    case "usage":
      return {
        ...p,
        usage: {
          inputTokens: p.usage.inputTokens + e.inputTokens,
          outputTokens: p.usage.outputTokens + e.outputTokens,
          costUsd: p.usage.costUsd + (e.costUsd ?? 0),
        },
      };
    case "done":
      return { ...p, finished: { ok: e.ok, exitCode: e.exitCode, error: e.error } };
    case "log":
      return p;
  }
}

/** Checklist labels, in the order phases run. */
export const PHASE_LABELS: Record<Phase, { todo: string; doing: string; done: string }> = {
  prepare: { todo: "Open the sandbox", doing: "Opening the sandbox", done: "Opened the sandbox" },
  clone: { todo: "Get the repository", doing: "Getting the repository", done: "Got the repository" },
  agent: { todo: "Do the work", doing: "Working", done: "Did the work" },
  publish: { todo: "Open the pull request", doing: "Opening the pull request", done: "Opened the pull request" },
};

/**
 * The thread's status checklist for a running task: its phases, with the
 * harness's own plan nested under the agent phase. Same format as
 * `update_status` (✓ done, ✱ in progress, ○ not started).
 */
export function renderChecklist(title: string, p: TaskProgress): string {
  const lines: string[] = [title, ""];
  for (const phase of Object.keys(PHASE_LABELS) as Phase[]) {
    const state = p.phases[phase];
    if (state === "skipped") continue;
    const label = PHASE_LABELS[phase];
    if (state === "done") lines.push(`✓ ${label.done}`);
    else if (state === "failed") lines.push(`✗ ${label.doing} failed${p.phaseDetail[phase] ? `: ${p.phaseDetail[phase]}` : ""}`);
    else if (state === "started") {
      const doing = phase === "agent" && p.lastTool ? `${label.doing}: ${clip(p.lastTool, 50)}` : label.doing;
      lines.push(`✱ ${doing}`);
    } else lines.push(`○ ${label.todo}`);
    if (phase === "agent") {
      for (const t of p.todos) {
        const mark = t.status === "done" ? "✓" : t.status === "in_progress" ? "✱" : "○";
        lines.push(`  ${mark} ${clip(t.text, 70)}`);
      }
    }
  }
  return lines.join("\n");
}

function clip(s: string, n: number) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
