import {
  type Artifact,
  CLI_NAMES,
  Decision,
  formatDecision,
  MAX_ARTIFACT_BYTES,
  type Message,
  type ProjectRepo,
  type ProjectWorkspace,
  type Thread,
} from "@altair/protocol";
import { z } from "zod";
import { type Tool, tool } from "../llm";
import { KNOWLEDGE_GUIDE, type KnowledgeSnapshot, renderKnowledge } from "./knowledge";
import type { TaskPlace } from "../sandbox/backend";
import { renderMessage } from "./render";
import type { RunTaskInput } from "./thread-tasks";

/** The thread operations the thread agent's tools act through. */
export type ThreadHost = {
  reply(text: string): Promise<Message>;
  publishArtifact(input: { artifactId?: string; title: string; description?: string; html: string }): Promise<Artifact>;
  setStatusText(text: string): Promise<void>;
  requestCoordinator(kind: "permission" | "routing" | "handoff", reason: string): Promise<void>;
  resolve(): Promise<void>;
  /** Starts a task in the sandbox; throws when it cannot. */
  runTask(input: RunTaskInput): Promise<string>;
  cancelTask(): Promise<string>;
  /** Directory listing of a connected repository. */
  listRepoFiles(repo: string, path: string, ref?: string): Promise<string>;
  /** Text of one file in a connected repository. */
  readRepoFile(repo: string, path: string, ref?: string): Promise<string>;
  /** Present when the project has a local folder: runs a task there and returns what to tell the model. */
};

export type CoordinatorNote = { body: string; createdAt: string; isNew: boolean };

export const THREAD_SYSTEM = `You are Altair, working one thread of a shared project. The coordinator opened this thread and handed you a brief. You own this thread: you decide how to do the work and you do it, then deliver the result here. To people, you and the coordinator are one assistant called Altair.

Tools:
- reply: the only way people see anything you say. Each reply is a message in this thread.
- update_status: your progress checklist, shown on the thread while you work. Line 1 is a short header, then a blank line, then one step per line prefixed with ✓ (done), ✱ (in progress) or ○ (not started). Post it first on multi-step work and refresh it as steps complete. It is not a reply and notifies no one.
- ask_decision: put a question to the person as a card with 2 to 4 options, one recommended. Use it instead of a reply whenever you need the person to choose; their pick arrives as their next message. Keep working on the recommended option meanwhile when you can.
- publish_artifact: publish a self-contained HTML page (a report, a chart, a small app, a prototype) as an artifact people open in a viewer next to the chat. Pass artifact_id to publish a new version of an existing artifact instead of a new one; the address stays the same. The page runs sandboxed on its own origin: inline your CSS and JS, load libraries only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com or esm.sh with an exact version, and do not call any other server. Give it a <title>, a background and a layout that works at phone width. Artifacts you publish are attached to your next reply as cards, so publish first, then reply with one line about it. Use an artifact when the result is something to look at or use, or longer than about fifteen lines; answer short things in the reply itself.
- request_coordinator: ask the coordinator for permission or direction when something is beyond this thread: touching another thread's work, a new piece of work that deserves its own thread, or any step that cannot be undone (deploying, deleting, sending something outside the project, spending money). Its answer arrives in a later turn. Do not wait idle; carry on with what you can.
- resolve_thread: mark the thread finished, once the person has what they asked for and nobody owes a next step. Do not resolve after only answering a question; leave it open for follow-ups.
- run_task: your hands. It runs a coding agent where the project's tasks run (see "Where tasks run" below): on the person's own computer, with their coding CLI (Claude Code, Codex or Gemini CLI, signed in with their own account) in the project's local folder; or in this thread's own Linux sandbox in the cloud (git, Node, Python, internet). Give it a self-contained prompt: the goal, what done looks like, and any constraints, because it sees nothing of this conversation. In the sandbox: with repo it clones the repository onto a fresh branch first; with open_pr it commits, pushes and opens a pull request when it finishes with changes (pass branch to update an existing pull request instead); each task's work is saved for the next one when the server keeps a workspace for the thread; harness "shell" runs the prompt as a bash script with no model, for quick commands such as running tests. On the person's computer, repo, branch, open_pr and harness do not apply: the CLI works in the local folder, and later tasks continue the same CLI session where the CLI supports it. One task runs at a time. Its progress shows on the thread's checklist by itself, so do not call update_status while it runs. Its result arrives in a later turn under "Tasks": then tell the person what was done, with the pull request link if there is one. Never ask the person for passwords, tokens or API keys for it.
- cancel_task: stop the running task.

- memory_read / memory_write / memory_delete, list_files / read_file / write_file: the project's memory and shared files (below).
- repo_list_files and repo_read_file: read the GitHub repositories connected to this project (listed in the prompt). Look at the code before answering questions about it. To change one or open a pull request, use run_task.

${KNOWLEDGE_GUIDE}

Use run_task for anything that needs code, files, commands or the internet. When a bug is reported against a repository, the person wants the fix: run a task that reproduces it, fixes it, runs the tests and opens a pull request. Outside those tasks, the repositories and the artifacts you publish, you have no internet access. Work from your own knowledge and the project's files, say so when facts may be out of date, and be clear about what you inferred. If the work needs the person's own files and no local folder is connected, tell them they can connect one from the project header.

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
  /** Rendered "Tasks" section (thread-tasks.ts), empty when none ran. */
  tasks?: string;
  workspace?: ProjectWorkspace | null;
  /** Where run_task would run now (the project's task target and its computer's state). */
  place?: TaskPlace;
  artifacts?: Artifact[];
}): string {
  const history = input.messages.map((m) => renderMessage(m, input.names, { isNew: m.seq > input.lastSeenSeq }));
  const notes = input.notes.map((n) => `- ${n.createdAt}${n.isNew ? " · NEW" : ""}: ${n.body}`);
  const ws = input.workspace;
  const place = input.place ?? { kind: "cloud" };
  const folder = ws ? `the local folder ${ws.path} on "${ws.runnerName}"` : "";
  const workspace = `## Where tasks run\n${
    place.kind === "local"
      ? `On the person's computer: ${folder}, with ${CLI_NAMES[place.workspace.cli]}.`
      : place.kind === "error"
        ? `Nowhere right now: ${place.message}`
        : `In this thread's cloud sandbox.${
            ws && !ws.online ? ` The project has ${folder}, but that computer is offline.` : ws ? ` The project also has ${folder}, but its setting sends tasks to the cloud.` : " No local folder is connected."
          }`
  }`;
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
    input.tasks ?? "",
    input.artifacts?.length
      ? `## Artifacts in this project (newest first; pass artifact_id to update one)\n${input.artifacts
          .map((a) => `- [${a.id}] "${a.title}" · v${a.version}${a.threadId === input.thread.id ? " · from this thread" : ""}`)
          .join("\n")}`
      : "",
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
      name: "publish_artifact",
      description:
        "Publish a self-contained HTML page as an artifact, or a new version of one (artifact_id). It is attached to your next reply.",
      input: z.object({
        title: z.string().trim().min(1).max(120),
        html: z.string().min(1).max(MAX_ARTIFACT_BYTES),
        description: z.string().max(500).optional().describe("One sentence shown on the artifact's card."),
        artifact_id: z.string().optional().describe("An existing artifact's id, to publish a new version of it."),
      }),
      run: async ({ title, html, description, artifact_id }) => {
        const a = await host.publishArtifact({ artifactId: artifact_id, title, description, html });
        return `Published "${a.title}" v${a.version} (${a.id}). It will be attached to your next reply.`;
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
      name: "run_task",
      description:
        "Start a coding agent in this thread's sandbox: clone a repository, edit code, run commands and tests, open a pull request. Returns at once; the result arrives in a later turn.",
      input: z.object({
        title: z.string().min(1).max(120).describe("Short name for the task, in the person's language."),
        prompt: z.string().min(1).max(32_000).describe("Self-contained instructions for the coding agent (or a bash script for harness shell)."),
        repo: z.string().max(300).optional().describe("Repository to work in: owner/name or an https URL."),
        branch: z.string().max(200).optional().describe("Existing branch to continue, e.g. a pull request's branch. Default: a new branch."),
        base_branch: z.string().max(200).optional().describe("Branch to start from. Default: the repository's default branch."),
        open_pr: z.boolean().optional().describe("Commit, push and open a pull request when done. Needs repo."),
        harness: z.enum(["opencode", "claude-code", "shell"]).optional().describe("Default opencode."),
        language: z.string().max(10).optional().describe("The person's language code, e.g. tr or en, for the checklist."),
      }),
      run: async (input) =>
        host.runTask({
          title: input.title,
          prompt: input.prompt,
          repo: input.repo,
          branch: input.branch,
          baseBranch: input.base_branch,
          openPr: input.open_pr,
          harness: input.harness,
          language: input.language,
        }),
    }),
    tool({
      name: "cancel_task",
      description: "Stop the task running in this thread.",
      input: z.object({}),
      run: () => host.cancelTask(),
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
