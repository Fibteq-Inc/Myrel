import { type Message, type Routine, type Thread, threadLink } from "@myrel/protocol";
import { z } from "zod";
import { type Tool, tool } from "../llm";
import { KNOWLEDGE_GUIDE, type KnowledgeHost, type KnowledgeSnapshot, knowledgeTools, renderKnowledge } from "./knowledge";
import { authorLabel, renderMessage, renderThread } from "./render";
import { renderRoutine, ROUTINE_GUIDE } from "./routine-tools";

/** Something the coordinator has not seen yet. */
export type InboxItem =
  | { kind: "message"; messageId: string }
  | { kind: "request"; threadId: string; request: "permission" | "routing" | "handoff"; reason: string }
  /** A routine ran and posted its prompt in the project chat as messageId. */
  | { kind: "routine"; messageId: string; routineId: string; name: string }
  /** Someone wrote in a thread (a person's decision, or the thread agent's reply) while other threads are open. */
  | { kind: "thread"; threadId: string; messageId: string };

/** A note the coordinator passed from one thread's work to another thread. */
export type Relay = { fromThreadId: string; toThreadId: string; note: string; createdAt: string };

/** The project operations the coordinator's tools act through. */
export type CoordinatorHost = {
  getMessage(id: string): Message | null;
  getThread(id: string): Thread | null;
  threadForRoot(messageId: string): Thread | null;
  post(body: string): Message;
  react(messageId: string, emoji: string): void;
  startThread(input: {
    rootMessageId: string;
    title: string;
    brief: string;
    ack?: string;
    projectAck?: string;
  }): Promise<Thread>;
  messageThread(threadId: string, note: string): Promise<void>;
  /** Tell an open thread what another thread's work means for it. Throws when the relay would repeat or bounce. */
  relay(fromThreadId: string, toThreadId: string, note: string): Promise<void>;
};

export const COORDINATOR_SYSTEM = `You are Myrel, the coordinator of a shared project chat. People post requests here; focused work happens in threads, each handled by its own thread agent. To people, you and every thread agent are one assistant called Myrel.

Your only job is routing. You never research, answer substantive questions, write content or do the work yourself, even when it looks quick. You decide where each message goes, and you keep the project chat calm.

For each new message in the project chat:
- A new ask (work, research, writing, a question that needs thought): call start_thread on that message. Give it a short title in the person's own words (a few words, not a sentence), a brief for the thread agent (the ask in your own words plus any context from the chat it needs, and the reasonable default you picked where the ask is unclear), a project_ack and an ack.
  - project_ack is the one line the person sees right under their message in the project chat, with the thread card under it. It only says, in a few natural words, that you got it and are starting ("Got it, starting now", "On it"). Word it differently each time, to fit the ask; it does not repeat the request or preview the work.
  - ack is the thread's opening line, saying what is being done first.
  - Do not also call post_message for it; project_ack is that post.
- A follow-up about an existing thread: call message_thread with the person's words and what they want, and a project_ack: one short line saying it went to that thread, with the thread written as a link people can tap to open it: [thread title](#thread_id), for example "Passed this on to the [Calculator](#thr_…) thread". A change to something a thread made or worked on ("make the calculator blue", "add a test to that fix") is a follow-up to that thread, even when the thread is resolved: message_thread reopens it, and that thread already has the files and the history. Start a new thread only for work no existing thread covers.
- A question about the project itself that the chat and thread list already answer (what threads exist, what one is waiting on): answer it with post_message, briefly.
- A greeting or FYI with nothing to do: one short post_message, or a react.
- Thanks or a sign-off: react with an emoji and nothing else.
- People talking among themselves: do nothing.

Several unrelated asks in one message: start a thread on that message for the first ask, with a project_ack. For each other ask, post one line naming it with post_message, then start a thread on that post (no project_ack needed; your post is the receipt).

${ROUTINE_GUIDE} A routine that targets the project chat posts its prompt there as a ⏰ notice when it runs; treat that notice as a new ask and start a thread on it. Creating, pausing and deleting routines is part of routing, so you do it yourself.

Requests from thread agents (permission, routing, handoff) arrive in your inbox. Answer each with message_thread: grant or refuse it, point the thread elsewhere, or, when only a person can decide (anything irreversible, spending, deleting, sending outside the project), tell the thread to ask the person in its thread. You never approve irreversible steps on a person's behalf.

Keeping threads in step: threads work in parallel, and what one thread starts, decides or delivers can change another thread's work. Examples: a new feature that another thread has to account for (a thread for a new kind of connector means the thread on plan limits must count it), a rename or a new server address, a renamed shared package, a decision a person made in one thread that another thread is waiting for, two threads about to change the same file. When you see such a link, call relay_to_thread to tell the affected thread in one or two sentences what changed and what it means for its work; when two threads would change the same file, say which thread owns it. Check for links whenever you start a thread (does an open thread need to know about this new work?) and whenever "Thread updates" lists new messages from inside threads. Relay only when it changes the recipient's work: most updates need nothing, and then you call no tools. Never send a note listed under "Notes already relayed" again, and never pass a thread's answer to your note back to the thread it came from. A decision people made in a thread that the whole project should keep (a name, a price, a rule) also goes in memory. Thread updates never get a post in the project chat: people already saw them in the thread.

${KNOWLEDGE_GUIDE}
You only route, so you can list files but not read or write them; that is thread work. You do write memory when people tell you how they want the project to run (who to involve, what to keep quiet about, decisions). A thread's brief should mention the instructions, memory or files that matter for its work.

Language: everything people read (posts, thread titles, acks) is in the language of the message you are handling. When it is too short to tell (an emoji, "ok"), use the language of the chat so far. These instructions being in English never sets the language. Write the brief in the person's language too, so the thread agent continues in it.

Style: plain, warm, short sentences. No em dashes. Never show ids to people; ids are only for tool calls and inside a thread link [thread title](#thread_id), which people see as the title and can tap. Use a thread link whenever you name a thread in the project chat. Call a thread "thread" in every language (in Turkish "thread", never "dal" or "konu"). When there is nothing to do, call no tools.`;

export function coordinatorPrompt(input: {
  projectName: string;
  names: Record<string, string>;
  chat: Message[];
  threads: Thread[];
  routines: Routine[];
  inbox: InboxItem[];
  /** New messages inside threads, for the thread items in the inbox. */
  threadUpdates?: { thread: Thread; message: Message }[];
  relays?: Relay[];
  knowledge: KnowledgeSnapshot;
  now: Date;
  defaultTimezone: string;
}): string {
  const newIds = new Set(input.inbox.flatMap((i) => (i.kind === "message" || i.kind === "routine" ? [i.messageId] : [])));
  const threadByRoot = new Map(input.threads.map((t) => [t.rootMessageId, t]));
  const chat = input.chat.map((m) => {
    const line = renderMessage(m, input.names, { isNew: newIds.has(m.id) });
    const thread = threadByRoot.get(m.id);
    return thread ? `${line}\n    ↳ thread [${thread.id}] "${thread.title}"` : line;
  });
  const requests = input.inbox.flatMap((i) =>
    i.kind === "request" ? [`- Thread [${i.threadId}] asks (${i.request}): ${i.reason}`] : [],
  );
  const ran = input.inbox.flatMap((i) =>
    i.kind === "routine" ? [`- Routine [${i.routineId}] "${i.name}" ran and posted [${i.messageId}]`] : [],
  );
  const titles = new Map(input.threads.map((t) => [t.id, t.title]));
  const updates = (input.threadUpdates ?? []).map(
    ({ thread, message }) =>
      `- Thread [${thread.id}] "${thread.title}" · ${authorLabel(message, input.names)} · ${message.createdAt}\n${indent(clip(message.body, UPDATE_MAX))}`,
  );
  const relays = (input.relays ?? []).map(
    (r) => `- ${r.createdAt}: "${titles.get(r.fromThreadId) ?? r.fromThreadId}" → "${titles.get(r.toThreadId) ?? r.toThreadId}": ${r.note}`,
  );
  const onlyThreadUpdates = input.inbox.length > 0 && input.inbox.every((i) => i.kind === "thread");

  return [
    `Project: ${input.projectName}\nCurrent time: ${input.now.toISOString()} (default time zone ${input.defaultTimezone})`,
    renderKnowledge(input.knowledge),
    `## Threads (open ones with their current plan)\n${input.threads.map(renderThreadWithPlan).join("\n") || "(none yet)"}`,
    `## Routines\n${input.routines.map(renderRoutine).join("\n") || "(none)"}`,
    `## Project chat, oldest first (messages marked NEW arrived since your last turn)\n${chat.join("\n\n") || "(empty)"}`,
    requests.length ? `## Requests from thread agents\n${requests.join("\n")}` : "",
    ran.length ? `## Routines that just ran (start a thread on each post)\n${ran.join("\n")}` : "",
    updates.length ? `## Thread updates (NEW messages inside threads; people saw them there)\n${updates.join("\n\n")}` : "",
    relays.length ? `## Notes already relayed between threads, newest last\n${relays.join("\n")}` : "",
    onlyThreadUpdates
      ? "Nothing new in the project chat. Relay only what changes another open thread's work; otherwise call no tools."
      : "Handle everything new now with your tools.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** How much of a thread message the coordinator reads; enough to spot a decision or a result. */
const UPDATE_MAX = 1200;
/** How much of an open thread's plan the coordinator reads. */
const PLAN_MAX = 300;

function renderThreadWithPlan(t: Thread): string {
  const line = renderThread(t);
  return !t.resolved && t.statusText ? `${line}\n${indent(clip(t.statusText, PLAN_MAX))}` : line;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function indent(text: string) {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

/**
 * The coordinator's tools. A turn that only has thread updates to look at gets just
 * relay_to_thread and memory: it must not post in the project chat or start threads.
 */
export function coordinatorTools(
  host: CoordinatorHost,
  knowledge: KnowledgeHost,
  opts: { onlyThreadUpdates?: boolean } = {},
): Tool[] {
  const relay = tool({
    name: "relay_to_thread",
    description:
      "Tell an open thread's agent (not shown to people) what another thread's new work, result or decision means for it. Only when it changes the recipient's work.",
    input: z.object({
      from_thread_id: z.string().describe("The thread whose work or decision this is about."),
      to_thread_id: z.string().describe("The open thread whose work it changes."),
      note: z
        .string()
        .min(1)
        .max(2000)
        .describe("One or two sentences: what changed and what it means for the recipient's work."),
    }),
    run: async ({ from_thread_id, to_thread_id, note }) => {
      await host.relay(from_thread_id, to_thread_id, note);
      return "Relayed.";
    },
  });
  // Routing needs memory and a view of the files, not file contents.
  const memory = knowledgeTools(knowledge).filter((t) => t.name.startsWith("memory_") || t.name === "list_files");
  if (opts.onlyThreadUpdates) return [...memory, relay];
  return [
    ...memory,
    relay,
    tool({
      name: "post_message",
      description: "Post a short message in the project chat, visible to every member.",
      input: z.object({ text: z.string().min(1).max(4000) }),
      run: ({ text }) => {
        const m = host.post(text);
        return `Posted ${m.id}.`;
      },
    }),
    tool({
      name: "start_thread",
      description:
        "Open a thread on a project-chat message and hand the work to a new thread agent. Use for every new ask.",
      input: z.object({
        message_id: z.string().describe("The project-chat message the thread hangs under, usually the person's ask."),
        title: z.string().min(1).max(80).describe("A few words naming what the thread is about."),
        instructions: z.string().min(1).max(8000).describe("The brief for the thread agent."),
        ack: z.string().max(400).optional().describe("One line posted as the thread's opening message."),
        project_ack: z
          .string()
          .max(200)
          .optional()
          .describe(
            "One short line posted in the project chat under the person's message, saying you got it and are starting. Required when the message is a person's.",
          ),
      }),
      run: async ({ message_id, title, instructions, ack, project_ack }) => {
        const root = host.getMessage(message_id);
        if (!root || root.threadId) throw new Error(`${message_id} is not a project-chat message.`);
        const existing = host.threadForRoot(message_id);
        if (existing) throw new Error(`That message already has thread ${existing.id}; use message_thread.`);
        // A person's ask always gets a visible "on it" line, not just a card.
        const projectAck = project_ack?.trim() || undefined;
        if (root.authorKind === "user" && !projectAck) {
          throw new Error("Add project_ack: one short line telling the person you got their message and are starting.");
        }
        const thread = await host.startThread({ rootMessageId: message_id, title, brief: instructions, ack, projectAck });
        return `Started thread ${thread.id}.`;
      },
    }),
    tool({
      name: "message_thread",
      description:
        "Send a note to a thread's agent (not shown to people): forward a follow-up, or answer its request.",
      input: z.object({
        thread_id: z.string(),
        note: z.string().min(1).max(8000),
        project_ack: z
          .string()
          .max(200)
          .optional()
          .describe(
            "When forwarding a person's follow-up: one short line posted in the project chat saying it went to that thread. Leave out when answering a thread's request.",
          ),
      }),
      run: async ({ thread_id, note, project_ack }) => {
        const thread = host.getThread(thread_id);
        if (!thread) throw new Error(`No thread ${thread_id}.`);
        await host.messageThread(thread_id, note);
        const ack = project_ack?.trim();
        // People should be one tap from the thread their message went to, even when the model forgot the link.
        if (ack) host.post(ack.includes(`(#${thread.id})`) ? ack : `${ack} ${threadLink(thread)}`);
        return "Delivered.";
      },
    }),
    tool({
      name: "react",
      description: "Add an emoji reaction to a message, e.g. 👍 for thanks or an acknowledgement.",
      input: z.object({ message_id: z.string(), emoji: z.string().min(1).max(16) }),
      run: ({ message_id, emoji }) => {
        if (!host.getMessage(message_id)) throw new Error(`No message ${message_id}.`);
        host.react(message_id, emoji);
        return "Reacted.";
      },
    }),
  ];
}
