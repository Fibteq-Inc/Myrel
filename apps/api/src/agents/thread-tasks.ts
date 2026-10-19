import type { Task, TerminalLine } from "@altair/protocol";
import type { TaskProgress } from "@altair/runner-core";

/** What the run_task tool asks for, before the server fills in ids, model and credentials. */
export type RunTaskInput = {
  title: string;
  prompt: string;
  harness?: "opencode" | "claude-code" | "shell";
  repo?: string;
  branch?: string;
  baseBranch?: string;
  openPr?: boolean;
  /** Language of the thread, for the checklist labels. */
  language?: string;
  /** Run it with the CLI on the person's computer (run_local_task) instead of the sandbox. */
  local?: boolean;
};

export type TaskWithLog = Task & { log: TerminalLine[] };

/** Terminal lines the thread agent sees from a finished task. */
const PROMPT_LOG_LINES = 40;
/** Task results are cut to this many characters in the prompt. */
const MAX_RESULT = 20_000;

/** The "Tasks" section of the thread agent's prompt. */
export function renderTasks(
  tasks: { task: Task; progress: TaskProgress; log: TerminalLine[]; isNew: boolean }[],
): string {
  if (tasks.length === 0) return "";
  const parts = tasks.map(({ task, progress, log, isNew }) => {
    const where = task.backend === "local" ? "on the person's computer" : "in the sandbox";
    const head = `### ${task.title} (${task.status}${isNew ? ", NEW result" : ""}) · ${task.harness} ${where}`;
    const lines = [head];
    if (task.prUrl) lines.push(`Pull request: ${task.prUrl}`);
    if (task.status === "running") {
      lines.push(progress.lastTool ? `Currently: ${progress.lastTool}` : "Starting.");
      return lines.join("\n");
    }
    if (task.summary) {
      const cut = task.summary.length > MAX_RESULT;
      lines.push(`Result:\n${cut ? `${task.summary.slice(0, MAX_RESULT)}\n[cut]` : task.summary}`);
    }
    if (isNew && log.length) {
      const tail = log.slice(-PROMPT_LOG_LINES).map((l) => (l.stream === "stdout" ? l.text : `[${l.stream}] ${l.text}`));
      lines.push(`Last terminal lines:\n\`\`\`\n${tail.join("\n")}\n\`\`\``);
    }
    return lines.join("\n");
  });
  return `## Tasks you ran in this thread (newest last)\n${parts.join("\n\n")}`;
}
