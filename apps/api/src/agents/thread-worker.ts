import { CLI_NAMES, Decision, formatDecision, type Message, type ProjectRepo, type ProjectWorkspace, type Thread } from "@altair/protocol";
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
  /** Directory listing of a connected repository. */
  listRepoFiles(repo: string, path: string, ref?: string): Promise<string>;
  /** Text of one file in a connected repository. */
  readRepoFile(repo: string, path: string, ref?: string): Promise<string>;
  /** Present when the project has a local folder: runs a task there and returns what to tell the model. */
  runLocalTask?: (prompt: string) => Promise<string>;
};

export type CoordinatorNote = { body: string; createdAt: string; isNew: boolean };

/** A task this thread ran on the person's computer. isNew = finished since the last turn. */
export type LocalTask = { prompt: string; status: "running" | "done" | "failed"; result: string | null; isNew: boolean };

export const THREAD_SYSTEM = `You are Altair, working one thread of a shared project. The coordinator opened this thread and handed you a brief. You own this thread: you decide how to do the work and you do it, then deliver the result here. To people, you and the coordinator are one assistant called Altair.

Tools:
- reply: the only way people see anything you say. Each reply is a message in this thread.
- update_status: your progress checklist, shown on the thread while you work. Line 1 is a short header, then a blank line, then one step per line prefixed with ✓ (done), ✱ (in progress) or ○ (not started). Post it first on multi-step work and refresh it as steps complete. It is not a reply and notifies no one.
- ask_decision: put a question to the person as a card with 2 to 4 options, one recommended. Use it instead of a reply whenever you need the person to choose; their pick arrives as their next message. Keep working on the recommended option meanwhile when you can.
- request_coordinator: ask the coordinator for permission or direction when something is beyond this thread: touching another thread's work, a new piece of work that deserves its own thread, or any step that cannot be undone (deploying, deleting, sending something outside the project, spending money). Its answer arrives in a later turn. Do not wait idle; carry on with what you can.
- resolve_thread: mark the thread finished, once the person has what they asked for and nobody owes a next step. Do not resolve after only answering a question; leave it open for follow-ups.

- memory_read / memory_write / memory_delete, list_files / read_file / write_file: the project's memory and shared files (below).
- repo_list_files and repo_read_file: read the GitHub repositories connected to this project (listed in the prompt). Look at the code before answering questions about it. You cannot change repositories or open pull requests yet; say so when asked.
- run_local_task (only when the project has a local folder connected): hand a task to the coding CLI on the person's own computer (Claude Code, Codex or Gemini CLI, signed in with their own account), working in that folder. Use it for anything that needs the project's files: reading code, editing, running commands or tests. Write the prompt as a complete, self-contained instruction; the CLI does not see this thread, but later tasks in this thread continue the same CLI session where the CLI supports it. The task runs in the background and its result arrives in a later turn, so after starting one, tell the person briefly and end the turn. Never ask the person for passwords, tokens or API keys for it.

${KNOWLEDGE_GUIDE}

Apart from those repositories and the local folder you have no internet access. Work from your own knowledge and the project's files, say so when facts may be out of date, and be clear about what you inferred. If the work needs the person's own files and no local folder is connected, tell them they can connect one from the project header.

How to answer:
- Lead with the answer. Match the shape of the ask: a one-line question gets a short answer, a "why" gets the cause, a request gets done with a sentence saying so.
- A reply carries only what changed since your last one. Do not replay your process.
- When the ask forks on a detail nobody gave, pick the reasonable default, say which, and keep going. Ask the person only when the answer changes their goal or something cannot be undone, and ask with ask_decision.
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
  repos: ProjectRepo[];
  tasks?: LocalTask[];
  workspace?: ProjectWorkspace | null;
}): string {
  const history = input.messages.map((m) => renderMessage(m, input.names, { isNew: m.seq > input.lastSeenSeq }));
  const notes = input.notes.map((n) => `- ${n.createdAt}${n.isNew ? " · NEW" : ""}: ${n.body}`);
  const tasks = (input.tasks ?? []).map(
    (t) =>
      `### ${t.status.toUpperCase()}${t.isNew ? " · NEW" : ""}\nPrompt: ${t.prompt}` +
      (t.result ? `\nResult:\n${t.result}` : ""),
  );
  const ws = input.workspace;
  const workspace = ws
    ? `## Local folder\n${ws.path} on "${ws.runnerName}", using ${CLI_NAMES[ws.cli]}. The computer is ${ws.online ? "online" : "offline right now, so run_local_task will fail until the person starts altair-runner again"}.`
    : "## Local folder\nNone connected.";
  return [
    `Project: ${input.projectName}\nThread: "${input.thread.title}"${input.thread.resolved ? " (resolved)" : ""}`,
    renderKnowledge(input.knowledge),
    `## Brief from the coordinator\n${input.brief}`,
    input.repos.length
      ? `## GitHub repositories connected to this project\n${input.repos
          .map((r) => `- ${r.fullName} (default branch ${r.defaultBranch}${r.private ? ", private" : ""})`)
          .join("\n")}`
      : "## GitHub repositories connected to this project\nNone. A project owner can connect one in the project settings.",
    `## The message this thread started from\n${renderMessage(input.root, input.names)}`,
    `## Thread so far, oldest first (NEW = arrived since your last turn)\n${history.join("\n\n") || "(no messages yet)"}`,
    notes.length ? `## Notes from the coordinator (not visible to people)\n${notes.join("\n")}` : "",
    workspace,
    tasks.length ? `## Tasks you ran on the person's computer, oldest first (NEW = finished since your last turn)\n${tasks.join("\n\n")}` : "",
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
    ...(host.runLocalTask ? [localTaskTool(host.runLocalTask)] : []),
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

function localTaskTool(run: (prompt: string) => Promise<string>): Tool {
  return tool({
    name: "run_local_task",
    description:
      "Run a task with the coding CLI on the person's computer, in the project's local folder. Returns at once; the result arrives in a later turn.",
    input: z.object({ prompt: z.string().min(1).max(50_000) }),
    run: async ({ prompt }) => run(prompt),
  });
}
