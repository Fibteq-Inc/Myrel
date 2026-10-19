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
    // Only tasks with a workspace save, and they say so when they start saving.
    phases: { prepare: "pending", clone: "pending", agent: "pending", save: "skipped", publish: "pending" },
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

type Labels = Record<Phase, { todo: string; doing: string; done: string; failed: string }> & {
  /** Known `detail` codes of a started phase, in words. */
  notes: Record<string, string>;
};

/** `detail` of a started prepare phase while the sandbox installs its tools the first time. */
export const SETUP_NOTE = "setup";

/** Checklist labels per language, phases in the order they run. Unknown languages use English. */
export const CHECKLIST_LABELS: Record<string, Labels> = {
  en: {
    prepare: { todo: "Open the sandbox", doing: "Opening the sandbox", done: "Opened the sandbox", failed: "Could not open the sandbox" },
    clone: { todo: "Get the repository", doing: "Getting the repository", done: "Got the repository", failed: "Could not get the repository" },
    agent: { todo: "Do the work", doing: "Working", done: "Did the work", failed: "The work failed" },
    save: { todo: "Save the work", doing: "Saving the work", done: "Saved the work", failed: "Could not save the work" },
    publish: { todo: "Open the pull request", doing: "Opening the pull request", done: "Opened the pull request", failed: "Could not open the pull request" },
    notes: { [SETUP_NOTE]: "installing the tools, only the first time (a few minutes)" },
  },
  tr: {
    prepare: { todo: "Sandbox'ı aç", doing: "Sandbox açılıyor", done: "Sandbox açıldı", failed: "Sandbox açılamadı" },
    clone: { todo: "Repoyu al", doing: "Repo alınıyor", done: "Repo alındı", failed: "Repo alınamadı" },
    agent: { todo: "İşi yap", doing: "Çalışıyor", done: "İş yapıldı", failed: "İş tamamlanamadı" },
    save: { todo: "Çalışmayı kaydet", doing: "Çalışma kaydediliyor", done: "Çalışma kaydedildi", failed: "Çalışma kaydedilemedi" },
    publish: { todo: "Pull request aç", doing: "Pull request açılıyor", done: "Pull request açıldı", failed: "Pull request açılamadı" },
    notes: { [SETUP_NOTE]: "araçlar kuruluyor, yalnızca ilk sefer (birkaç dakika)" },
  },
};

/**
 * The thread's status checklist for a running task: its phases, with the
 * harness's own plan nested under the agent phase. Same format as
 * `update_status` (✓ done, ✱ in progress, ○ not started).
 */
export function renderChecklist(title: string, p: TaskProgress, language = "en"): string {
  const labels = CHECKLIST_LABELS[language.toLowerCase().slice(0, 2)] ?? CHECKLIST_LABELS.en!;
  const lines: string[] = [title, ""];
  const phases: Phase[] = ["prepare", "clone", "agent", "save", "publish"];
  // A task that failed outside any phase (the sandbox never started) shows it on the step it was on.
  const failedAt =
    p.finished && !p.finished.ok && !phases.some((ph) => p.phases[ph] === "failed")
      ? phases.find((ph) => p.phases[ph] === "started" || p.phases[ph] === "pending")
      : undefined;
  for (const phase of phases) {
    // Progress stored before a phase existed has no entry for it.
    const state = failedAt === phase ? "failed" : (p.phases[phase] ?? "skipped");
    const detail = failedAt === phase ? p.finished?.error : p.phaseDetail[phase];
    if (state === "skipped") continue;
    const label = labels[phase];
    if (state === "done") lines.push(`✓ ${label.done}`);
    else if (state === "failed") lines.push(`✗ ${label.failed}${detail ? `: ${clip(detail, 120)}` : ""}`);
    else if (state === "started") {
      const note = phase === "agent" ? p.lastTool : detail && (labels.notes[detail] ?? detail);
      const doing = note ? `${label.doing}: ${clip(note, phase === "agent" ? 50 : 80)}` : label.doing;
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
