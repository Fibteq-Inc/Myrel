import type { Message, Reaction, ServerEvent, Thread } from "@altair/protocol";

/**
 * Client-side view of a project's live channel. Pure functions so web and
 * mobile share one reducer: feed it `ProjectSocket`'s messages and events.
 */
export type ProjectState = {
  /** Every message, project chat and threads, in seq order. */
  messages: Message[];
  threads: Record<string, Thread>;
  reactions: Record<string, Reaction[]>;
  /** Agents working right now: "" is the coordinator, otherwise a thread id. */
  active: Record<string, true>;
};

export const emptyProjectState: ProjectState = { messages: [], threads: {}, reactions: {}, active: {} };

export function applyMessage(state: ProjectState, message: Message): ProjectState {
  return { ...state, messages: [...state.messages, message] };
}

/** Applies the non-message parts of a server event (messages arrive through `applyMessage`). */
export function applyEvent(state: ProjectState, event: ServerEvent): ProjectState {
  switch (event.type) {
    case "thread.updated":
      return { ...state, threads: { ...state.threads, [event.thread.id]: event.thread } };
    case "reaction.added":
      return { ...state, reactions: addReactions(state.reactions, [event.reaction]) };
    case "agent.activity": {
      const key = event.threadId ?? "";
      const active = { ...state.active };
      if (event.active) active[key] = true;
      else delete active[key];
      return { ...state, active };
    }
    case "sync.result": {
      const threads = { ...state.threads };
      for (const t of event.threads) threads[t.id] = t;
      return { ...state, threads, reactions: addReactions(state.reactions, event.reactions) };
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

export const projectChat = (s: ProjectState) => s.messages.filter((m) => m.threadId === null);

export const threadMessages = (s: ProjectState, threadId: string) => s.messages.filter((m) => m.threadId === threadId);

export function threadByRoot(s: ProjectState): Map<string, Thread> {
  return new Map(Object.values(s.threads).map((t) => [t.rootMessageId, t]));
}

export type ChecklistItem = { state: "done" | "active" | "todo" | "failed"; text: string };

/** Parses an `update_status` checklist: a header line, then ✓ / ✱ / ○ steps (✗ marks a failed step). */
export function parseChecklist(text: string): { title: string; items: ChecklistItem[] } {
  // The just-finished step may be bolded: **✓ step**.
  const lines = text.split("\n").map((l) => l.trim().replace(/^\*\*(.*)\*\*$/, "$1").trim());
  const marks: Record<string, ChecklistItem["state"]> = { "✓": "done", "✱": "active", "○": "todo", "✗": "failed" };
  const items: ChecklistItem[] = [];
  let title = "";
  for (const line of lines) {
    if (!line) continue;
    const state = marks[line[0]!];
    if (state) items.push({ state, text: line.slice(1).trim() });
    else if (!title && items.length === 0) title = line;
  }
  return { title, items };
}
