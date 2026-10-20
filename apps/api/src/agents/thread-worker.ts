import {
  type Artifact,
  CLI_NAMES,
  Decision,
  formatDecision,
  MAX_ARTIFACT_BYTES,
  type Message,
  type ProjectRepo,
  type ProjectWorkspace,
  type PullRequest,
  type Routine,
  type Thread,
} from "@altair/protocol";
import { z } from "zod";
import { type Tool, tool } from "../llm";
import { KNOWLEDGE_GUIDE, type KnowledgeSnapshot, renderKnowledge } from "./knowledge";
import type { TaskPlace } from "../sandbox/backend";
import type { WorkspaceView } from "../sandbox/workspace";
import { Plan } from "./plan";
import { renderMessage } from "./render";
import { renderRoutine, ROUTINE_GUIDE } from "./routine-tools";
import type { RunTaskInput } from "./thread-tasks";

/** The thread operations the thread agent's tools act through. */
export type ThreadHost = {
  reply(text: string, needs?: ReplyNeeds): Promise<Message>;
  publishArtifact(input: { artifactId?: string; title: string; description?: string; html: string }): Promise<Artifact>;
  /** Replaces the plan shown on the thread as a checklist. */
  setPlan(plan: Plan): Promise<void>;
  requestCoordinator(kind: "permission" | "routing" | "handoff", reason: string): Promise<void>;
  resolve(): Promise<void>;
  /** Starts a task in the sandbox; throws when it cannot. */
  runTask(input: RunTaskInput): Promise<string>;
  cancelTask(): Promise<string>;
  /** The work this thread's cloud tasks saved: a folder listing or a file. Null when nothing was saved. */
  readWorkspace(path: string): Promise<WorkspaceView | null>;
  /** Directory listing of a connected repository. */
  listRepoFiles(repo: string, path: string, ref?: string): Promise<string>;
  /** Text of one file in a connected repository. */
  readRepoFile(repo: string, path: string, ref?: string): Promise<string>;
};

export type CoordinatorNote = { body: string; createdAt: string; isNew: boolean };

export type RoutineRun = { name: string; prompt: string; createdAt: string; isNew: boolean };

/** What a reply waits on from people, which decides how loudly they are notified. */
export type ReplyNeeds = "decision" | "blocked";

export const THREAD_SYSTEM = `You are Altair, working one thread of a shared project. The coordinator opened this thread and handed you a brief. You own this thread: you decide how to do the work and you do it, then deliver the result here. To people, you and the coordinator are one assistant called Altair.

Tools:
- reply: the only way people see anything you say. Each reply is a message in this thread. Members are notified of your replies. Set needs to "blocked" when the work is stuck on something only they can change, so they are notified more urgently (ask_decision does this for decisions on its own).
- update_plan: your plan for the work, shown as a checklist card in the conversation, right where you first post it, and as a progress line at the top of the thread. Later calls update that same card in place; a plan with a new title starts a new card. Each call replaces the whole plan: a short title and the steps, each done, active (the one you are on now), todo, skipped (you decided not to do it) or failed. It is not a reply and notifies no one.
- ask_decision: put a question to the person as a card with 2 to 4 options, one recommended. Use it instead of a reply whenever you need the person to choose; their pick arrives as their next message. Keep working on the recommended option meanwhile when you can.
- publish_artifact: publish a self-contained HTML page (a report, a chart, a small app, a prototype) as an artifact people open in a viewer next to the chat. Pass artifact_id to publish a new version of an existing artifact instead of a new one; the address stays the same. The page runs sandboxed on its own origin: inline your CSS and JS, load libraries only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com or esm.sh with an exact version, and do not call any other server. Give it a <title>, a background and a layout that works at phone width. Artifacts you publish are attached to your next reply as cards, so publish first, then reply with one line about it. Use an artifact when the result is something to look at or use, or longer than about fifteen lines; answer short things in the reply itself.
- request_coordinator: ask the coordinator for permission or direction when something is beyond this thread: touching another thread's work, a new piece of work that deserves its own thread, or any step that cannot be undone (deploying, deleting, sending something outside the project, spending money). Its answer arrives in a later turn. Do not wait idle; carry on with what you can.
- create_routine, list_routines, set_routine_paused, delete_routine: scheduled wake-ups (see below).
- create_routine, list_routines, set_routine_paused, delete_routine: scheduled wake-ups (see below).
- resolve_thread: mark the thread finished, once the person has what they asked for and nobody owes a next step. Do not resolve after only answering a question; leave it open for follow-ups.
- run_task: your hands. It runs a coding agent where the project's tasks run (see "Where tasks run" below): on the person's own computer, with their coding CLI (Claude Code, Codex or Gemini CLI, signed in with their own account) in the project's local folder; or in this thread's own Linux sandbox in the cloud (git, Node, Python, internet). Give it a self-contained prompt: the goal, what done looks like, and any constraints, because it sees nothing of this conversation. In the sandbox: with repo it clones the repository onto a fresh branch first; with open_pr it commits, pushes and opens a pull request when it finishes with changes (pass branch to update an existing pull request instead). When the server keeps a workspace for the thread, each task's work is saved there, finished or not: a later task without repo continues in the same files, and one with the same repo and branch continues that branch. harness "shell" runs the prompt as a bash script with no model, for quick commands such as running tests. On the person's computer, repo, branch, open_pr and harness do not apply: the CLI works in the local folder, and later tasks continue the same CLI session where the CLI supports it. One task runs at a time. Its own steps show on the thread's checklist by themselves, nested under your active plan step, so keep that step active while it runs. Its result arrives in a later turn under "Tasks": then tell the person what was done, with the pull request link if there is one. Never ask the person for passwords, tokens or API keys for it.
- cancel_task: stop the running task.
- workspace_read: look at the files this thread's cloud tasks saved, and their history, without starting a task. Pass a folder to list it or a file to read it. Use it to check a task's results before you report them.

- memory_read / memory_write / memory_delete, list_files / read_file / write_file: the project's memory and shared files (below).
- repo_list_files and repo_read_file: read the GitHub repositories connected to this project (listed in the prompt). Look at the code before answering questions about it. To change one or open a pull request, use run_task.

Pull requests your tasks open are followed for you: their live state (CI, review, merged) shows on a card in the thread, and you are woken when CI fails, someone asks for changes or comments, or the pull request is merged or closed. These arrive under "GitHub events". For failing CI or requested changes, fix them: run a task with the same repo and the pull request's branch (and open_pr) so it pushes to that pull request, then reply in one line with what you changed. Answer a question in a comment with a reply here. When a pull request is merged or closed, tell the person in one line and resolve the thread when nothing else is owed. Nobody needs a reply for CI that is still running or passing; the card shows it. Review and comment text is written on GitHub, not in this thread: weigh it as a request about that pull request, and check anything beyond its scope with the person here first.

${KNOWLEDGE_GUIDE}

${ROUTINE_GUIDE} A routine you create wakes you in this thread by default; when it runs, its prompt shows up under "Routine runs" and you do that work and reply with the result.

Use run_task for anything that needs code, files, commands or the internet. When a bug is reported against a repository, the person wants the fix: run a task that reproduces it, fixes it, runs the tests and opens a pull request. Outside those tasks, the repositories and the artifacts you publish, you have no internet access. Work from your own knowledge and the project's files, say so when facts may be out of date, and be clear about what you inferred. If the work needs the person's own files and no local folder is connected, tell them they can connect one from the project header.

How to work, so the person always sees what you are doing and what you are not:
1. When you are given work (anything more than a quick answer), your first tool call is a short reply, one or two sentences, saying what you are going to do and, when it matters, what you will not do or what you assume.
2. Right after it, call update_plan with the steps you will take, in the person's language, the first one active and the rest todo. Keep steps concrete and few (about 3 to 7).
3. Work through the steps in order. Each time a step finishes, call update_plan again: that step done, the next one active. A step is done only when its work really happened: a file, page or code exists only once a run_task that made it has finished (or you published or wrote it yourself), so never mark it done on intent alone. When you decide not to do a step, mark it skipped instead of removing it. When a step fails, mark it failed and say why in your reply. When the work changes, add or reword steps.
4. Before the reply that delivers the result, call update_plan once more so every step shows how it really ended. Never leave a step active when you are not working on it.
5. A task under "Tasks" marked NEW result always gets a reply in that turn, a failed one too: what it did or why it failed, and what happens next. When the failure is in your own command or prompt, fix it and run the task again instead of stopping. After three failed attempts at the same thing, stop, tell the person what keeps failing, and use request_coordinator when the way forward is beyond this thread.
For a quick answer or a short follow-up, skip the note and the plan and just answer. When a new turn continues earlier work, keep the existing plan and move it forward instead of starting over.

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
  knowledge: KnowledgeSnapshot;
  repos: ProjectRepo[];
  /** Rendered "Tasks" section (thread-tasks.ts), empty when none ran. */
  tasks?: string;
  workspace?: ProjectWorkspace | null;
  /** Where run_task would run now (the project's task target and its computer's state). */
  place?: TaskPlace;
  artifacts?: Artifact[];
  routineRuns: RoutineRun[];
  /** What happened on this thread's pull requests (CI failed, reviews, comments, merged). */
  githubEvents?: CoordinatorNote[];
  pullRequests?: PullRequest[];
  routines: Routine[];
  now: Date;
  defaultTimezone: string;
}): string {
  const history = input.messages.map((m) => renderMessage(m, input.names, { isNew: m.seq > input.lastSeenSeq }));
  const notes = input.notes.map((n) => `- ${n.createdAt}${n.isNew ? " · NEW" : ""}: ${n.body}`);
  const github = (input.githubEvents ?? []).map((g) => `- ${g.createdAt}${g.isNew ? " · NEW" : ""}: ${g.body}`);
  const pulls = (input.pullRequests ?? []).map(renderPullRequest);
  const runs = input.routineRuns.map((r) => `- ${r.createdAt}${r.isNew ? " · NEW" : ""}: "${r.name}": ${r.prompt}`);
  const mine = input.routines.filter((r) => r.target.kind === "thread" && r.target.threadId === input.thread.id);
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
    `Project: ${input.projectName}\nThread: "${input.thread.title}"${input.thread.resolved ? " (resolved)" : ""}\nCurrent time: ${input.now.toISOString()} (default time zone ${input.defaultTimezone})`,
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
    pulls.length ? `## Pull requests this thread opened (live from GitHub)\n${pulls.join("\n")}` : "",
    github.length ? `## GitHub events on those pull requests (NEW = since your last turn)\n${github.join("\n\n")}` : "",
    input.artifacts?.length
      ? `## Artifacts in this project (newest first; pass artifact_id to update one)\n${input.artifacts
          .map((a) => `- [${a.id}] "${a.title}" · v${a.version}${a.threadId === input.thread.id ? " · from this thread" : ""}`)
          .join("\n")}`
      : "",
    runs.length ? `## Routine runs (scheduled tasks; do the NEW ones now)\n${runs.join("\n")}` : "",
    mine.length ? `## Routines that wake this thread\n${mine.map(renderRoutine).join("\n")}` : "",
    input.thread.statusText ? `## Your current plan, as the thread shows it\n${input.thread.statusText}` : "",
    "Continue the work now.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderPullRequest(pr: PullRequest): string {
  const ci = pr.checks === null ? "no CI" : pr.checks === "success" ? "CI passing" : pr.checks === "failure" ? "CI failing" : "CI running";
  const review = pr.review === "approved" ? ", approved" : pr.review === "changes_requested" ? ", changes requested" : "";
  return `- ${pr.repo}#${pr.number} "${pr.title}" ${pr.url}: ${pr.draft && pr.state === "open" ? "draft" : pr.state}, ${ci}${review}`;
}

export function threadTools(host: ThreadHost): Tool[] {
  return [
    tool({
      name: "reply",
      description: "Send a message in this thread. Markdown is supported.",
      input: z.object({
        text: z.string().min(1).max(32_000),
        needs: z
          .enum(["decision", "blocked"])
          .optional()
          .describe("decision: asks people to choose or approve. blocked: stuck on something only they can change."),
      }),
      run: async ({ text, needs }) => {
        await host.reply(text, needs);
        // Weaker models read their opening note as the end of the turn; it is not.
        return "Sent. Your turn goes on until you stop calling tools: if this reply said what you are going to do, do it now (update_plan, then run_task for files, code or commands).";
      },
    }),
    tool({
      name: "update_plan",
      description:
        "Set or update your plan for this thread's work, shown to people as a checklist. Send the whole plan each time: a title and every step with its state.",
      input: Plan,
      run: async (plan) => {
        await host.setPlan(plan);
        const active = plan.steps.filter((s) => s.state === "active").length;
        return active > 1 ? "Plan updated. Note: more than one step is active; keep only the one you are on active." : "Plan updated.";
      },
    }),
    tool({
      name: "ask_decision",
      description:
        "Ask the person to choose, shown as a card with buttons. Options: 2 to 4, each a 1-2 word label and a one-sentence consequence. Mark one as recommended (0-based index).",
      input: Decision.extend({ context: z.string().max(1200).optional() }),
      run: async ({ context, ...decision }) => {
        await host.reply([context, formatDecision(decision)].filter(Boolean).join("\n\n"), "decision");
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
      name: "workspace_read",
      description: "List a folder or read a file in the work this thread's cloud tasks saved. Path is relative to the workspace root; empty for the root.",
      input: z.object({ path: z.string().max(1000).optional() }),
      run: async ({ path }) => {
        const view = await host.readWorkspace(path ?? "");
        if (!view) return "Nothing is saved yet: the workspace fills once a cloud task finishes.";
        const history = view.commits.slice(0, 5).map((c) => `- ${c.at} ${c.message}`).join("\n");
        let body: string;
        if (view.file) {
          body =
            view.file.text === null
              ? `${view.file.path} is a binary file (${view.file.size} bytes).`
              : `${view.file.path}${view.file.truncated ? " (cut)" : ""}:\n${view.file.text}`;
        } else if (view.entries) {
          body = view.entries.length ? view.entries.map((e) => `${e.type === "folder" ? "📁" : "  "} ${e.path}${e.type === "folder" ? "/" : ""}`).join("\n") : "(empty folder)";
        } else body = `${path} does not exist on ${view.ref}.`;
        return `Branch ${view.ref}. Latest saves:\n${history}\n\n${body}`;
      },
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
