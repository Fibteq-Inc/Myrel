import {
  type Artifact,
  Decision,
  formatDecision,
  MAX_ARTIFACT_BYTES,
  type Message,
  type ProjectRepo,
  type PullRequest,
  type Routine,
  type Thread,
} from "@altair/protocol";
import { z } from "zod";
import { type Tool, tool } from "../llm";
import { type KnowledgeSnapshot, renderKnowledge } from "./knowledge";
import { Plan } from "./plan";
import { renderMessage } from "./render";
import { renderRoutine } from "./routine-tools";

/** The thread operations the thread agent's tools act through. */
export type ThreadHost = {
  /** `files`: project file paths attached to the message, shown as cards people open. */
  reply(text: string, needs?: ReplyNeeds, files?: string[]): Promise<Message>;
  publishArtifact(input: { artifactId?: string; title: string; description?: string; html: string }): Promise<Artifact>;
  /** Replaces the plan shown on the thread as a checklist. */
  setPlan(plan: Plan): Promise<void>;
  requestCoordinator(kind: "permission" | "routing" | "handoff", reason: string): Promise<void>;
  resolve(): Promise<void>;
  /** Follows a pull request on a connected repository; says what happened. */
  trackPullRequest(url: string): Promise<string>;
  /** Directory listing of a connected repository. */
  listRepoFiles(repo: string, path: string, ref?: string): Promise<string>;
  /** Text of one file in a connected repository. */
  readRepoFile(repo: string, path: string, ref?: string): Promise<string>;
};

export type CoordinatorNote = { body: string; createdAt: string; isNew: boolean };

export type RoutineRun = { name: string; prompt: string; createdAt: string; isNew: boolean };

/** What a reply waits on from people, which decides how loudly they are notified. */
export type ReplyNeeds = "decision" | "blocked";

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
        files: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Project file paths to attach (files you made, e.g. reports/summary.xlsx); upload them first."),
      }),
      run: async ({ text, needs, files }) => {
        await host.reply(text, needs, files);
        // Weaker models read their opening note as the end of the turn; it is not.
        return "Sent.";
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
      name: "track_pull_request",
      description:
        "Follow a pull request you opened on a connected repository: its CI, reviews and merge show in the thread and wake you.",
      input: z.object({ url: z.string().url().describe("The pull request's github.com link.") }),
      run: ({ url }) => host.trackPullRequest(url),
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
