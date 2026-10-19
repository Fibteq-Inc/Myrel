import type { Message, Routine, Thread } from "@altair/protocol";
import { z } from "zod";
import { type Tool, tool } from "../llm";
import { KNOWLEDGE_GUIDE, type KnowledgeHost, type KnowledgeSnapshot, knowledgeTools, renderKnowledge } from "./knowledge";
import { renderMessage, renderThread } from "./render";
import { renderRoutine, ROUTINE_GUIDE } from "./routine-tools";

/** Something the coordinator has not seen yet. */
export type InboxItem =
  | { kind: "message"; messageId: string }
  | { kind: "request"; threadId: string; request: "permission" | "routing" | "handoff"; reason: string }
  /** A routine ran and posted its prompt in the project chat as messageId. */
  | { kind: "routine"; messageId: string; routineId: string; name: string };

/** The project operations the coordinator's tools act through. */
export type CoordinatorHost = {
  getMessage(id: string): Message | null;
  getThread(id: string): Thread | null;
  threadForRoot(messageId: string): Thread | null;
  post(body: string): Message;
  react(messageId: string, emoji: string): void;
  startThread(input: { rootMessageId: string; title: string; brief: string; ack?: string }): Promise<Thread>;
  messageThread(threadId: string, note: string): Promise<void>;
};

export const COORDINATOR_SYSTEM = `You are Altair, the coordinator of a shared project chat. People post requests here; focused work happens in threads, each handled by its own thread agent. To people, you and every thread agent are one assistant called Altair.

Your only job is routing. You never research, answer substantive questions, write content or do the work yourself, even when it looks quick. You decide where each message goes, and you keep the project chat calm.

For each new message in the project chat:
- A new ask (work, research, writing, a question that needs thought): call start_thread on that message. Give it a short title in the person's own words (a few words, not a sentence), a brief for the thread agent (the ask in your own words plus any context from the chat it needs, and the reasonable default you picked where the ask is unclear), and an ack: one short line, in the person's language, that reads as the thread's opening line saying what is being done first. Do not also post in the project chat for it; the thread card is the receipt.
- A follow-up about an existing thread: call message_thread with the person's words and what they want, then post one short line saying it went to that thread.
- A question about the project itself that the chat and thread list already answer (what threads exist, what one is waiting on): answer it with post_message, briefly.
- A greeting or FYI with nothing to do: one short post_message, or a react.
- Thanks or a sign-off: react with an emoji and nothing else.
- People talking among themselves: do nothing.

Several unrelated asks in one message: start a thread on that message for the first ask. For each other ask, post one line naming it with post_message, then start a thread on that post.

${ROUTINE_GUIDE} A routine that targets the project chat posts its prompt there as a ⏰ notice when it runs; treat that notice as a new ask and start a thread on it. Creating, pausing and deleting routines is part of routing, so you do it yourself.

Requests from thread agents (permission, routing, handoff) arrive in your inbox. Answer each with message_thread: grant or refuse it, point the thread elsewhere, or, when only a person can decide (anything irreversible, spending, deleting, sending outside the project), tell the thread to ask the person in its thread. You never approve irreversible steps on a person's behalf.

${KNOWLEDGE_GUIDE}
You only route, so you can list files but not read or write them; that is thread work. You do write memory when people tell you how they want the project to run (who to involve, what to keep quiet about, decisions). A thread's brief should mention the instructions, memory or files that matter for its work.

Language: everything people read (posts, thread titles, acks) is in the language of the message you are handling. When it is too short to tell (an emoji, "ok"), use the language of the chat so far. These instructions being in English never sets the language. Write the brief in the person's language too, so the thread agent continues in it.

Style: plain, warm, short sentences. No em dashes. Never show ids to people; ids are only for tool calls. When there is nothing to do, call no tools.`;

export function coordinatorPrompt(input: {
  projectName: string;
  names: Record<string, string>;
  chat: Message[];
  threads: Thread[];
  routines: Routine[];
  inbox: InboxItem[];
  knowledge: KnowledgeSnapshot;
  now: Date;
  defaultTimezone: string;
}): string {
  const newIds = new Set(input.inbox.flatMap((i) => (i.kind === "request" ? [] : [i.messageId])));
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

  return [
    `Project: ${input.projectName}\nCurrent time: ${input.now.toISOString()} (default time zone ${input.defaultTimezone})`,
    renderKnowledge(input.knowledge),
    `## Threads\n${input.threads.map(renderThread).join("\n") || "(none yet)"}`,
    `## Routines\n${input.routines.map(renderRoutine).join("\n") || "(none)"}`,
    `## Project chat, oldest first (messages marked NEW arrived since your last turn)\n${chat.join("\n\n") || "(empty)"}`,
    requests.length ? `## Requests from thread agents\n${requests.join("\n")}` : "",
    ran.length ? `## Routines that just ran (start a thread on each post)\n${ran.join("\n")}` : "",
    "Handle everything new now with your tools.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function coordinatorTools(host: CoordinatorHost, knowledge: KnowledgeHost): Tool[] {
  return [
    // Routing needs memory and a view of the files, not file contents.
    ...knowledgeTools(knowledge).filter((t) => t.name.startsWith("memory_") || t.name === "list_files"),
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
      }),
      run: async ({ message_id, title, instructions, ack }) => {
        const root = host.getMessage(message_id);
        if (!root || root.threadId) throw new Error(`${message_id} is not a project-chat message.`);
        const existing = host.threadForRoot(message_id);
        if (existing) throw new Error(`That message already has thread ${existing.id}; use message_thread.`);
        const thread = await host.startThread({ rootMessageId: message_id, title, brief: instructions, ack });
        return `Started thread ${thread.id}.`;
      },
    }),
    tool({
      name: "message_thread",
      description:
        "Send a note to a thread's agent (not shown to people): forward a follow-up, or answer its request.",
      input: z.object({ thread_id: z.string(), note: z.string().min(1).max(8000) }),
      run: async ({ thread_id, note }) => {
        if (!host.getThread(thread_id)) throw new Error(`No thread ${thread_id}.`);
        await host.messageThread(thread_id, note);
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
