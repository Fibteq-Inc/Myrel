import {
  type Artifact,
  type Message,
  type MessageStats,
  isPlanMessage,
  type PullRequest,
  type Reaction,
  type Routine,
  type ServerEvent,
  type Task,
  type TerminalLine,
  type Thread,
} from "@myrel/protocol";

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

/**
 * Splits a run of pull requests into the cards worth showing and the rest,
 * so a thread that opened many does not stack a card for each. Open ones
 * stay out (they still need someone); with none open, the one updated last
 * does. Two or fewer are all shown. Both lists keep the given order.
 */
export function foldPullRequests(prs: PullRequest[]): { shown: PullRequest[]; folded: PullRequest[] } {
  if (prs.length <= 2) return { shown: prs, folded: [] };
  const open = prs.filter((pr) => pr.state === "open");
  const keep = new Set(
    open.length ? open : [prs.reduce((a, b) => (b.updatedAt.localeCompare(a.updatedAt) >= 0 ? b : a))],
  );
  return { shown: prs.filter((pr) => keep.has(pr)), folded: prs.filter((pr) => !keep.has(pr)) };
}

export const threadTasks = (s: ProjectState, threadId: string) =>
  Object.values(s.tasks)
    .filter((t) => t.threadId === threadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export function applyMessage(state: ProjectState, message: Message): ProjectState {
  return applyMessages(state, [message]);
}

/** Adds a run of new messages in one step (a sync page), instead of copying the list once per message. */
export function applyMessages(state: ProjectState, messages: Message[]): ProjectState {
  if (messages.length === 0) return state;
  return { ...state, messages: state.messages.concat(messages) };
}

/** Applies the non-message parts of a server event (messages arrive through `applyMessage`). */
export function applyEvent(state: ProjectState, event: ServerEvent): ProjectState {
  switch (event.type) {
    case "message.updated":
      return { ...state, messages: state.messages.map((m) => (m.id === event.message.id ? event.message : m)) };
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
      // Agents still working are sent again right after the sync, so any other "thinking" is stale.
      return {
        ...state,
        threads,
        artifacts,
        routines,
        reactions: addReactions(state.reactions, event.reactions),
        active: {},
        progress: {},
      };
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

const EMPTY: Message[] = [];
const byThreadCache = new WeakMap<Message[], Map<string | null, Message[]>>();

/**
 * Messages grouped by thread (null = project chat), built once per messages
 * array: every view asks for its slice on each render, and a long project has
 * thousands of messages across dozens of threads.
 */
function messagesByThread(messages: Message[]): Map<string | null, Message[]> {
  let index = byThreadCache.get(messages);
  if (!index) {
    index = new Map();
    for (const m of messages) {
      const list = index.get(m.threadId);
      if (list) list.push(m);
      else index.set(m.threadId, [m]);
    }
    byThreadCache.set(messages, index);
  }
  return index;
}

/** The project chat's messages. The same array comes back until the messages change. */
export const projectChat = (s: ProjectState) => messagesByThread(s.messages).get(null) ?? EMPTY;

/** One thread's messages. The same array comes back until the messages change. */
export const threadMessages = (s: ProjectState, threadId: string) => messagesByThread(s.messages).get(threadId) ?? EMPTY;

/** What one message's stats line counts, its task included. Cost is null when any part has no price. */
export function messageUsage(st: MessageStats): { inputTokens: number; outputTokens: number; durationMs: number; costMicros: number | null } {
  const { task } = st;
  return {
    inputTokens: st.inputTokens + (task?.inputTokens ?? 0),
    outputTokens: st.outputTokens + (task?.outputTokens ?? 0),
    durationMs: st.durationMs + (task?.durationMs ?? 0),
    // A person's own CLI is unpriced on purpose; it counts as free rather than unknown.
    costMicros:
      st.runtime === "local" && st.harness
        ? 0
        : st.costMicros === null || task?.costMicros === null
          ? null
          : st.costMicros + (task?.costMicros ?? 0),
  };
}

/** What a thread's messages say they used, summed: null when none of them carries stats. Cost is null when any part has no price. */
export function threadUsage(s: ProjectState, threadId: string): { tokens: number; durationMs: number; costMicros: number | null } | null {
  let total: { tokens: number; durationMs: number; costMicros: number | null } | null = null;
  for (const m of threadMessages(s, threadId)) {
    if (!m.stats) continue;
    const u = messageUsage(m.stats);
    total ??= { tokens: 0, durationMs: 0, costMicros: 0 };
    total.tokens += u.inputTokens + u.outputTokens;
    total.durationMs += u.durationMs;
    total.costMicros = total.costMicros === null || u.costMicros === null ? null : total.costMicros + u.costMicros;
  }
  return total;
}

/** How many replies a thread has, not counting the agent's plan cards and plan update notes. */
export function threadReplyCount(s: ProjectState, threadId: string): number {
  const messages = threadMessages(s, threadId);
  let count = replyCountCache.get(messages);
  if (count === undefined) {
    count = messages.filter((m) => !isPlanMessage(m.body)).length;
    replyCountCache.set(messages, count);
  }
  return count;
}
const replyCountCache = new WeakMap<Message[], number>();

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

/**
 * The plan's top-level steps the person has not seen yet: those whose text is
 * not in `seen`, the step texts they had in view last time. A step the agent
 * only ticks keeps its text, so it never counts as new.
 */
export function freshSteps(items: ChecklistItem[], seen: ReadonlySet<string>): Set<string> {
  return new Set(items.filter((i) => i.depth === 0 && !seen.has(i.text)).map((i) => i.text));
}
