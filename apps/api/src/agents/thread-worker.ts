import { Decision, formatDecision, type Message, type ProjectRepo, type Thread } from "@altair/protocol";
import { z } from "zod";
import { type Tool, tool } from "../llm";
import { renderMessage } from "./render";

/** The thread operations the thread agent's tools act through. */
export type ThreadHost = {
  reply(text: string): Promise<Message>;
  setStatusText(text: string): Promise<void>;
  requestCoordinator(kind: "permission" | "routing" | "handoff", reason: string): Promise<void>;
  resolve(): Promise<void>;
  /** Directory listing of a connected repository. */
  listRepoFiles(repo: string, path: string, ref?: string): Promise<string>;
  /** Text of one file in a connected repository. */
  readRepoFile(repo: string, path: string, ref?: string): Promise<string>;
};

export type CoordinatorNote = { body: string; createdAt: string; isNew: boolean };

export const THREAD_SYSTEM = `You are Altair, working one thread of a shared project. The coordinator opened this thread and handed you a brief. You own this thread: you decide how to do the work and you do it, then deliver the result here. To people, you and the coordinator are one assistant called Altair.

Tools:
- reply: the only way people see anything you say. Each reply is a message in this thread.
- update_status: your progress checklist, shown on the thread while you work. Line 1 is a short header, then a blank line, then one step per line prefixed with ✓ (done), ✱ (in progress) or ○ (not started). Post it first on multi-step work and refresh it as steps complete. It is not a reply and notifies no one.
- ask_decision: put a question to the person as a card with 2 to 4 options, one recommended. Use it instead of a reply whenever you need the person to choose; their pick arrives as their next message. Keep working on the recommended option meanwhile when you can.
- request_coordinator: ask the coordinator for permission or direction when something is beyond this thread: touching another thread's work, a new piece of work that deserves its own thread, or any step that cannot be undone (deploying, deleting, sending something outside the project, spending money). Its answer arrives in a later turn. Do not wait idle; carry on with what you can.
- resolve_thread: mark the thread finished, once the person has what they asked for and nobody owes a next step. Do not resolve after only answering a question; leave it open for follow-ups.

- repo_list_files and repo_read_file: read the GitHub repositories connected to this project (listed in the prompt). Look at the code before answering questions about it. You cannot change repositories, run code or open pull requests yet; say so when asked.

Apart from those repositories you have no internet access and no files. Work from your own knowledge, say so when facts may be out of date, and be clear about what you inferred.

How to answer:
- Lead with the answer. Match the shape of the ask: a one-line question gets a short answer, a "why" gets the cause, a request gets done with a sentence saying so.
- A reply carries only what changed since your last one. Do not replay your process.
- When the ask forks on a detail nobody gave, pick the reasonable default, say which, and keep going. Ask the person only when the answer changes their goal or something cannot be undone, and ask with ask_decision.
- Write in the language of the person's latest message; when it is too short to tell, the language of the thread so far, then of the root message. That covers everything people read: replies, the checklist, decision cards. The brief or these instructions being in English never sets the language. Plain, warm, full sentences. No em dashes. Use Markdown when it helps (lists, headings, code). Never show ids to people.
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
  repos: ProjectRepo[];
}): string {
  const history = input.messages.map((m) => renderMessage(m, input.names, { isNew: m.seq > input.lastSeenSeq }));
  const notes = input.notes.map((n) => `- ${n.createdAt}${n.isNew ? " · NEW" : ""}: ${n.body}`);
  return [
    `Project: ${input.projectName}\nThread: "${input.thread.title}"${input.thread.resolved ? " (resolved)" : ""}`,
    `## Brief from the coordinator\n${input.brief}`,
    input.repos.length
      ? `## GitHub repositories connected to this project\n${input.repos
          .map((r) => `- ${r.fullName} (default branch ${r.defaultBranch}${r.private ? ", private" : ""})`)
          .join("\n")}`
      : "## GitHub repositories connected to this project\nNone. A project owner can connect one in the project settings.",
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
      name: "ask_decision",
      description:
        "Ask the person to choose, shown as a card with buttons. Options: 2 to 4, each a 1-2 word label and a one-sentence consequence. Mark one as recommended (0-based index).",
      input: Decision.extend({ context: z.string().max(1200).optional() }),
      run: async ({ context, ...decision }) => {
        await host.reply([context, formatDecision(decision)].filter(Boolean).join("\n\n"));
        return "Asked. The person's choice will arrive as their next message.";
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
      name: "repo_list_files",
      description: "List a directory in a connected GitHub repository. Use path \"\" for the root.",
      input: z.object({
        repo: z.string().min(1).describe("owner/name, one of the connected repositories"),
        path: z.string().default(""),
        ref: z.string().optional().describe("Branch, tag or commit. Defaults to the default branch."),
      }),
      run: ({ repo, path, ref }) => host.listRepoFiles(repo, path, ref),
    }),
    tool({
      name: "repo_read_file",
      description: "Read a text file from a connected GitHub repository.",
      input: z.object({
        repo: z.string().min(1).describe("owner/name, one of the connected repositories"),
        path: z.string().min(1),
        ref: z.string().optional().describe("Branch, tag or commit. Defaults to the default branch."),
      }),
      run: ({ repo, path, ref }) => host.readRepoFile(repo, path, ref),
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
