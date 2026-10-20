import type { Artifact, Message, PullRequest, Reaction, Routine, ServerEvent, Task, TerminalLine, Thread } from "@altair/protocol";

/**
 * Client-side view of a project's live channel. Pure functions so web and
 * mobile share one reducer: feed it `ProjectSocket`'s messages and events.
 */
export type ProjectState = {
  /** Every message, project chat and threads, in seq order. */
  messages: Message[];
  threads: Record<string, Thread>;
  reactions: Record<string, Reaction[]>;
  artifacts: Record<string, Artifact>;
  routines: Record<string, Routine>;
  /** Agents working right now: "" is the coordinator, otherwise a thread id. */
  active: Record<string, true>;
  /** What an active agent is doing, when it said (e.g. a task on the person's computer). */
  progress: Record<string, string>;
  /** Tasks (run_task) seen live or loaded with `applyTasks`, by id. */
  tasks: Record<string, Task>;
  /** Terminal output per task id, oldest first, capped at MAX_TERMINAL_LINES. */
  output: Record<string, TerminalLine[]>;
  /** Pull requests threads opened, seen live or loaded with `applyPullRequests`, by URL. */
  pullRequests: Record<string, PullRequest>;
};

export const emptyProjectState: ProjectState = {
  messages: [],
  threads: {},
  reactions: {},
  artifacts: {},
  routines: {},
  active: {},
  progress: {},
  tasks: {},
  output: {},
  pullRequests: {},
};

/** Terminal lines kept per task on the client. */
export const MAX_TERMINAL_LINES = 1000;

/** Adds tasks fetched from the tasks endpoint, with their earlier output. */
export function applyTasks(state: ProjectState, tasks: (Task & { log?: TerminalLine[] })[]): ProjectState {
  const next = { ...state, tasks: { ...state.tasks }, output: { ...state.output } };
  for (const { log, ...task } of tasks) {
    next.tasks[task.id] = task;
    // Live lines that arrived while fetching are newer than the fetched log.
    if (log) next.output[task.id] = [...log, ...(state.output[task.id] ?? [])].slice(-MAX_TERMINAL_LINES);
  }
  return next;
}

/** Adds pull requests fetched from the pull requests endpoint. */
export function applyPullRequests(state: ProjectState, pullRequests: PullRequest[]): ProjectState {
  const next = { ...state.pullRequests };
  // A live update that arrived while fetching is at least as new as the fetched copy.
  for (const pr of pullRequests) if (!next[pr.url] || next[pr.url]!.updatedAt < pr.updatedAt) next[pr.url] = pr;
  return { ...state, pullRequests: next };
}

export const threadPullRequests = (s: ProjectState, threadId: string) =>
  Object.values(s.pullRequests).filter((pr) => pr.threadId === threadId);

export const threadTasks = (s: ProjectState, threadId: string) =>
  Object.values(s.tasks)
    .filter((t) => t.threadId === threadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export function applyMessage(state: ProjectState, message: Message): ProjectState {
  return { ...state, messages: [...state.messages, message] };
}

/** Applies the non-message parts of a server event (messages arrive through `applyMessage`). */
export function applyEvent(state: ProjectState, event: ServerEvent): ProjectState {
  switch (event.type) {
    case "thread.updated":
      return { ...state, threads: { ...state.threads, [event.thread.id]: event.thread } };
    case "artifact.updated":
      return { ...state, artifacts: { ...state.artifacts, [event.artifact.id]: event.artifact } };
    case "routine.updated":
      return { ...state, routines: { ...state.routines, [event.routine.id]: event.routine } };
    case "routine.deleted": {
      const { [event.routineId]: _, ...routines } = state.routines;
      return { ...state, routines };
    }
    case "reaction.added":
      return { ...state, reactions: addReactions(state.reactions, [event.reaction]) };
    case "agent.activity": {
      const key = event.threadId ?? "";
      const active = { ...state.active };
      const progress = { ...state.progress };
      if (event.active) active[key] = true;
      else delete active[key];
      if (event.active && event.label) progress[key] = event.label;
      else delete progress[key];
      return { ...state, active, progress };
    }
    case "task.updated":
      return { ...state, tasks: { ...state.tasks, [event.task.id]: event.task } };
    case "pr.updated":
      return { ...state, pullRequests: { ...state.pullRequests, [event.pullRequest.url]: event.pullRequest } };
    case "task.output": {
      const lines = [...(state.output[event.taskId] ?? []), ...event.lines].slice(-MAX_TERMINAL_LINES);
      return { ...state, output: { ...state.output, [event.taskId]: lines } };
    }
    case "sync.result": {
      const threads = { ...state.threads };
      for (const t of event.threads) threads[t.id] = t;
      const artifacts = { ...state.artifacts };
      for (const a of event.artifacts) artifacts[a.id] = a;
      // The sync carries every routine, so it replaces the list (deletions while offline drop out).
      const routines = Object.fromEntries(event.routines.map((r) => [r.id, r]));
      return { ...state, threads, artifacts, routines, reactions: addReactions(state.reactions, event.reactions) };
    }
    default:
      return state;
  }
}

function addReactions(current: Record<string, Reaction[]>, added: Reaction[]) {
  if (added.length === 0) return current;
  const next = { ...current };
  for (const r of added) {
    const list = next[r.messageId] ?? [];
    const dupe = list.some((x) => x.emoji === r.emoji && x.authorId === r.authorId);
    if (!dupe) next[r.messageId] = [...list, r];
  }
  return next;
}

/** The project's artifacts, most recently updated first (the Library). */
export const artifactList = (s: ProjectState) =>
  Object.values(s.artifacts).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

export const projectChat = (s: ProjectState) => s.messages.filter((m) => m.threadId === null);

export const threadMessages = (s: ProjectState, threadId: string) => s.messages.filter((m) => m.threadId === threadId);

export function threadByRoot(s: ProjectState): Map<string, Thread> {
  return new Map(Object.values(s.threads).map((t) => [t.rootMessageId, t]));
}

/**
 * Threads keyed by the project-chat message their card sits under: the coordinator's acknowledgement
 * line when there is one, so the chat reads ask, "on it", card. Otherwise the root message.
 */
export function threadByCard(s: ProjectState): Map<string, Thread> {
  return new Map(Object.values(s.threads).map((t) => [t.ackMessageId ?? t.rootMessageId, t]));
}

export type ChecklistItem = {
  state: "done" | "active" | "todo" | "skipped" | "failed";
  text: string;
  /** 0 for a step of the agent's plan; 1 and 2 for the steps of a task nested under it. */
  depth: number;
};

/**
 * Parses a thread's checklist: a header line, then ✓ / ✱ / ○ steps (✗ marks a
 * failed step, – one the agent decided to skip). Indented steps belong to the
 * step above them.
 */
export function parseChecklist(text: string): { title: string; items: ChecklistItem[] } {
  const marks: Record<string, ChecklistItem["state"]> = { "✓": "done", "✱": "active", "○": "todo", "–": "skipped", "✗": "failed" };
  const items: ChecklistItem[] = [];
  let title = "";
  for (const raw of text.split("\n")) {
    const indent = raw.length - raw.trimStart().length;
    // The just-finished step may be bolded: **✓ step**.
    const line = raw.trim().replace(/^\*\*(.*)\*\*$/, "$1").trim();
    if (!line) continue;
    const state = marks[line[0]!];
    if (state) items.push({ state, text: line.slice(1).trim(), depth: Math.min(2, Math.floor(indent / 2)) });
    else if (!title && items.length === 0) title = line;
  }
  return { title, items };
}

/** How far a checklist is: its top-level steps done, out of those not skipped. */
export function checklistProgress(items: ChecklistItem[]): { done: number; total: number } {
  const steps = items.filter((i) => i.depth === 0 && i.state !== "skipped");
  return { done: steps.filter((i) => i.state === "done").length, total: steps.length };
}
