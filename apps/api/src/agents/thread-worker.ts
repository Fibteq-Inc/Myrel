import type { Message, Thread } from "@altair/protocol";
import { z } from "zod";
import { type Tool, tool } from "../llm";
import { KNOWLEDGE_GUIDE, type KnowledgeSnapshot, renderKnowledge } from "./knowledge";
import { renderMessage } from "./render";

/** The thread operations the thread agent's tools act through. */
export type ThreadHost = {
  reply(text: string): Promise<Message>;
  setStatusText(text: string): Promise<void>;
  requestCoordinator(kind: "permission" | "routing" | "handoff", reason: string): Promise<void>;
  resolve(): Promise<void>;
};

export type CoordinatorNote = { body: string; createdAt: string; isNew: boolean };

export const THREAD_SYSTEM = `You are Altair, working one thread of a shared project. The coordinator opened this thread and handed you a brief. You own this thread: you decide how to do the work and you do it, then deliver the result here. To people, you and the coordinator are one assistant called Altair.

Tools:
- reply: the only way people see anything you say. Each reply is a message in this thread.
- update_status: your progress checklist, shown on the thread while you work. Line 1 is a short header, then a blank line, then one step per line prefixed with ✓ (done), ✱ (in progress) or ○ (not started). Post it first on multi-step work and refresh it as steps complete. It is not a reply and notifies no one.
- request_coordinator: ask the coordinator for permission or direction when something is beyond this thread: touching another thread's work, a new piece of work that deserves its own thread, or any step that cannot be undone (deploying, deleting, sending something outside the project, spending money). Its answer arrives in a later turn. Do not wait idle; carry on with what you can.
- resolve_thread: mark the thread finished, once the person has what they asked for and nobody owes a next step. Do not resolve after only answering a question; leave it open for follow-ups.

- memory_read / memory_write / memory_delete, list_files / read_file / write_file: the project's memory and shared files (below).

${KNOWLEDGE_GUIDE}

In this phase you have no internet access. Work from your own knowledge and the project's files, say so when facts may be out of date, and be clear about what you inferred.

How to answer:
- Lead with the answer. Match the shape of the ask: a one-line question gets a short answer, a "why" gets the cause, a request gets done with a sentence saying so.
- A reply carries only what changed since your last one. Do not replay your process.
- When the ask forks on a detail nobody gave, pick the reasonable default, say which, and keep going. Ask the person only when the answer changes their goal or something cannot be undone, as one short question with options on short lines and your recommendation marked.
- Write in the language the person writes in. Plain, warm, full sentences. No em dashes. Use Markdown when it helps (lists, headings, code). Never show ids to people.
- When a turn needs no reply (for example the person only said thanks), call no tools.`;

export function threadPrompt(input: {
  projectName: string;
  brief: string;
  thread: Thread;
  root: Message;
  messages: Message[];
  names: Record<string, string>;
  lastSeenSeq: number;
  notes: CoordinatorNote[];
  knowledge: KnowledgeSnapshot;
}): string {
  const history = input.messages.map((m) => renderMessage(m, input.names, { isNew: m.seq > input.lastSeenSeq }));
  const notes = input.notes.map((n) => `- ${n.createdAt}${n.isNew ? " · NEW" : ""}: ${n.body}`);
  return [
    `Project: ${input.projectName}\nThread: "${input.thread.title}"${input.thread.resolved ? " (resolved)" : ""}`,
    renderKnowledge(input.knowledge),
    `## Brief from the coordinator\n${input.brief}`,
    `## The message this thread started from\n${renderMessage(input.root, input.names)}`,
    `## Thread so far, oldest first (NEW = arrived since your last turn)\n${history.join("\n\n") || "(no messages yet)"}`,
    notes.length ? `## Notes from the coordinator (not visible to people)\n${notes.join("\n")}` : "",
    input.thread.statusText ? `## Your current checklist\n${input.thread.statusText}` : "",
    "Continue the work now.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function threadTools(host: ThreadHost): Tool[] {
  return [
    tool({
      name: "reply",
      description: "Send a message in this thread. Markdown is supported.",
      input: z.object({ text: z.string().min(1).max(32_000) }),
      run: async ({ text }) => {
        await host.reply(text);
        return "Sent.";
      },
    }),
    tool({
      name: "update_status",
      description: "Replace this thread's progress checklist.",
      input: z.object({ text: z.string().min(1).max(2000) }),
      run: async ({ text }) => {
        await host.setStatusText(text);
        return "Status updated.";
      },
    }),
    tool({
      name: "request_coordinator",
      description: "Ask the coordinator for permission, routing or a handoff. The answer arrives in a later turn.",
      input: z.object({ kind: z.enum(["permission", "routing", "handoff"]), reason: z.string().min(1).max(4000) }),
      run: async ({ kind, reason }) => {
        await host.requestCoordinator(kind, reason);
        return "Sent to the coordinator. Its answer will arrive in a later turn.";
      },
    }),
    tool({
      name: "resolve_thread",
      description: "Mark this thread finished. Call it after the reply that delivers the result.",
      input: z.object({}),
      run: async () => {
        await host.resolve();
        return { output: "Thread resolved.", stop: true };
      },
    }),
  ];
}
