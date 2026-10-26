import {
  type Artifact,
  type ConversationPage,
  type Message,
  type PullRequest,
  type Reaction,
  type Routine,
  type ServerEvent,
  summarizeThread,
  type Task,
  type TerminalLine,
  type Thread,
  type ThreadSummary,
} from "@myrel/protocol";

/**
 * Client-side view of a project's live channel. Pure functions so web and
 * mobile share one reducer: feed it `ProjectSocket`'s messages and events.
 */
export type ProjectState = {
  /** The messages held, project chat and threads, in seq order: all of them, or (`windowed`) the newest of each conversation loaded. */
  messages: Message[];
  /**
   * The server sent only the newest messages: a conversation is held from its newest message back as
   * far as `windows` says, and one not in `windows` (a thread not opened yet) only has what arrived live.
   */
  windowed: boolean;
  /** Per conversation ("" is the project chat, otherwise a thread id): whether older messages are left on the server. */
  windows: Record<string, { hasEarlier: boolean }>;
  /** Messages held outside their conversation's list: the project-chat messages threads opened from, by id. */
  loose: Record<string, Message>;
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
  windowed: false,
  windows: {},
  loose: {},
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

/**
 * Adds a page of one conversation fetched from the server (null: the project chat): its messages go
 * into place by seq, skipping any already held, and the conversation now reaches as far back as the page.
 */
export function applyConversationPage(state: ProjectState, threadId: string | null, page: ConversationPage): ProjectState {
  const held = new Set(state.messages.map((m) => m.id));
  const fresh = page.messages.filter((m) => !held.has(m.id));
  const messages = fresh.length ? [...fresh, ...state.messages].sort((a, b) => a.seq - b.seq) : state.messages;
  return {
    ...state,
    messages,
    windows: { ...state.windows, [threadId ?? ""]: { hasEarlier: page.hasEarlier } },
    loose: page.root ? { ...state.loose, [page.root.id]: page.root } : state.loose,
    reactions: addReactions(state.reactions, page.reactions),
  };
}

/**
 * How much of a conversation is held (null: the project chat). Not `loaded`: a thread the server
 * has not sent yet, to fetch with `GET messages?conversation`. `hasEarlier`: older messages are left on the server.
 */
export function conversationState(s: ProjectState, threadId: string | null): { loaded: boolean; hasEarlier: boolean } {
  if (!s.windowed) return { loaded: true, hasEarlier: false };
  const window = s.windows[threadId ?? ""];
  return window ? { loaded: true, hasEarlier: window.hasEarlier } : { loaded: false, hasEarlier: true };
}

/** A message by id, wherever it is held (e.g. the project-chat message a thread opened from). */
export function findMessage(s: ProjectState, id: string): Message | undefined {
  return s.loose[id] ?? s.messages.find((m) => m.id === id);
}

/** Applies the non-message parts of a server event (messages arrive through `applyMessage`). */
export function applyEvent(state: ProjectState, event: ServerEvent): ProjectState {
  switch (event.type) {
    case "message.updated":
      return {
        ...state,
        messages: state.messages.map((m) => (m.id === event.message.id ? event.message : m)),
        loose: state.loose[event.message.id] ? { ...state.loose, [event.message.id]: event.message } : state.loose,
      };
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
      // A sync with only the newest messages starts the conversations it holds over (and, after a reset, all of them).
      const windows = event.windows ? { ...(event.reset ? {} : state.windows) } : state.windows;
      for (const w of event.windows ?? []) windows[w.threadId ?? ""] = { hasEarlier: w.hasEarlier };
      // Agents still working are sent again right after the sync, so any other "thinking" is stale.
      return {
        ...state,
        ...(event.reset && { messages: [], loose: {} }),
        windowed: state.windowed || !!event.windows,
        windows,
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

export { messageUsage } from "@myrel/protocol";

/** What a thread's messages add up to: the server's summary, or added up here for an older server's thread. */
export function threadSummary(s: ProjectState, threadId: string): ThreadSummary {
  const fromServer = s.threads[threadId]?.summary;
  if (fromServer) return fromServer;
  const messages = threadMessages(s, threadId);
  let summary = summaryCache.get(messages);
  if (!summary) {
    summary = summarizeThread(messages);
    summaryCache.set(messages, summary);
  }
  return summary;
}
const summaryCache = new WeakMap<Message[], ThreadSummary>();

/** What a thread's messages say they used, summed: null when none of them carries stats. Cost is null when any part has no price. */
export function threadUsage(s: ProjectState, threadId: string): ThreadSummary["usage"] {
  return threadSummary(s, threadId).usage;
}

/**
 * How many agents are working in the project right now: the coordinator and every thread that is
 * active or marked working and not resolved, each once. Counts the same way as the project list's
 * `activity.working`, which the server keeps from the same signals.
 */
export function workingCount(s: ProjectState): number {
  const working = new Set(Object.keys(s.active));
  for (const thread of Object.values(s.threads)) {
    if (thread.status === "working" && !thread.resolved) working.add(thread.id);
  }
  return working.size;
}

/** How many replies a thread has, not counting the agent's plan cards and plan update notes. */
export function threadReplyCount(s: ProjectState, threadId: string): number {
  return threadSummary(s, threadId).replies;
}

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
