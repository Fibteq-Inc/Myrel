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
} from "@myrel/protocol";
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
  /** It set a plan this turn. */
  planned(): boolean;
  requestCoordinator(kind: "permission" | "routing" | "handoff", reason: string): Promise<void>;
  /**
   * Puts a choice card to people: straight away when askPerson, otherwise to the coordinator first,
   * which answers from what the project already knows or passes the card on. Says where it went.
   */
  askDecision(input: { decision: Decision; context?: string; askPerson: boolean }): Promise<"person" | "coordinator">;
  /** Marks the thread finished, or says why it cannot be yet. */
  resolve(): Promise<string | null>;
  /** Follows a pull request on a connected repository; says what happened. */
  trackPullRequest(url: string): Promise<string>;
  /** Asks the person, with a card, to connect a GitHub repository to the project; says what happened. */
  requestRepo(repo: string, reason: string): Promise<string>;
  /** Opens a pull request on a connected repository through Myrel's GitHub App; says what happened. */
  openPullRequest(input: { repo: string; head: string; base?: string; title: string; body?: string; draft?: boolean }): Promise<string>;
  /** Closes a pull request this thread opened, and asks the person about its branch when asked to; says what happened. */
  closePullRequest(input: { url: string; reason: string; deleteBranch: boolean }): Promise<string>;
  /** Directory listing of a connected repository. */
  listRepoFiles(repo: string, path: string, ref?: string): Promise<string>;
  /** Text of one file in a connected repository. */
  readRepoFile(repo: string, path: string, ref?: string): Promise<string>;
};

export type CoordinatorNote = { body: string; createdAt: string; isNew: boolean };

export type RoutineRun = { name: string; prompt: string; createdAt: string; isNew: boolean };

/**
 * What a reply waits on from people, which decides how loudly they are notified. review: it
 * presented something (a proposal, a draft, an artifact) and waits for their feedback.
 */
export type ReplyNeeds = "decision" | "blocked" | "review";

export function threadPrompt(input: {
  projectName: string;
  brief: string;
  thread: Thread;
  root: Message;
  messages: Message[];
  names: Record<string, string>;
  lastSeenSeq: number;
  /** When the agent's last turn began: a message a person edited after it is new again. */
  lastSeenAt?: string;
  /** Edits the last turn already took in while it ran (message id → editedAt): not new again. */
  editsTaken?: Record<string, string>;
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
  /**
   * For a CLI session that continues the last turn and so already holds the thread: only the
   * messages that arrived since, without the message the thread started from.
   */
  followUp?: boolean;
  /** Set when this turn continues one the runner's restart cut off (see auto-resume.ts). */
  resumeNote?: string;
  /** The thread's plan belongs to a round that finished before the thread was reopened. */
  planFinished?: boolean;
  /** Passes each section that stays the same from turn to turn (memory, brief, repositories…); "" leaves it out. */
  lasting?: (section: string) => string;
  /** The most characters the prompt may take: the oldest messages and coordinator notes go first (see fitPrompt). */
  budget?: number;
}): string {
  const lasting = input.lasting ?? ((section: string) => section);
  const isNew = (m: Message) =>
    m.seq > input.lastSeenSeq || (editedSince(m, input.lastSeenAt) && input.editsTaken?.[m.id] !== m.editedAt);
  const shown = input.followUp ? input.messages.filter(isNew) : input.messages;
  const history = shown.map((m) => renderMessage(m, input.names, { isNew: isNew(m) }));
  const notes = input.notes.map((n) => `- ${n.createdAt}${n.isNew ? " · NEW" : ""}: ${n.body}`);
  const github = (input.githubEvents ?? []).map((g) => `- ${g.createdAt}${g.isNew ? " · NEW" : ""}: ${g.body}`);
  const pulls = (input.pullRequests ?? []).map(renderPullRequest);
  const runs = input.routineRuns.map((r) => `- ${r.createdAt}${r.isNew ? " · NEW" : ""}: "${r.name}": ${r.prompt}`);
  const mine = input.routines.filter((r) => r.target.kind === "thread" && r.target.threadId === input.thread.id);
  // Once each: lasting records every section it passes, for the next turn to compare with.
  const head = [
    `Project: ${input.projectName}\nThread: "${input.thread.title}"${input.thread.resolved ? " (resolved)" : ""}\nCurrent time: ${input.now.toISOString()} (default time zone ${input.defaultTimezone})`,
    lasting(renderKnowledge(input.knowledge)),
    lasting(`## Brief from the coordinator\n${input.brief}`),
    lasting(
      input.repos.length
        ? `## GitHub repositories connected to this project\n${input.repos
            .map((r) => `- ${r.fullName} (default branch ${r.defaultBranch}${r.private ? ", private" : ""})`)
            .join("\n")}`
        : "## GitHub repositories connected to this project\nNone. A project owner can connect one in the project settings.",
    ),
    input.followUp ? "" : `## The message this thread started from\n${renderMessage(input.root, input.names)}`,
  ];
  const tail = [
    pulls.length ? lasting(`## Pull requests this thread opened (live from GitHub)\n${pulls.join("\n")}`) : "",
    github.length ? `## GitHub events on those pull requests (NEW = since your last turn)\n${github.join("\n\n")}` : "",
    input.artifacts?.length
      ? lasting(
          `## Artifacts in this project (newest first; pass artifact_id to update one)\n${input.artifacts
            .map((a) => `- [${a.id}] "${a.title}" · v${a.version}${a.threadId === input.thread.id ? " · from this thread" : ""}`)
            .join("\n")}`,
        )
      : "",
    runs.length ? `## Routine runs (scheduled tasks; do the NEW ones now)\n${runs.join("\n")}` : "",
    mine.length ? lasting(`## Routines that wake this thread\n${mine.map(renderRoutine).join("\n")}`) : "",
    input.thread.statusText
      ? input.planFinished
        ? `## Your plan from the earlier round (finished before this thread was reopened)\n${input.thread.statusText}\n\nThis is new work: set a new plan with update_plan for it rather than adding steps to this one.`
        : `## Your current plan, as the thread shows it\n${input.thread.statusText}`
      : "",
    input.resumeNote ?? "",
    "Continue the work now.",
  ];
  const render = (left: { history: number; notes: number }) => {
    const leftOut = (n: number, what: string) => (n ? `(The ${n} oldest ${what} are left out to keep this prompt within its size limit.)` : "");
    const messages = [leftOut(left.history, "messages"), ...history.slice(left.history)].filter(Boolean).join("\n\n");
    const shownNotes = notes.slice(left.notes);
    const noteText = shownNotes.length ? [leftOut(left.notes, "notes"), ...shownNotes].filter(Boolean).join("\n") : "";
    return [
      ...head,
      input.followUp
        ? `## New in the thread since your last turn, oldest first (the earlier messages are in this session already; one marked edited is an earlier message a person changed, so its new text replaces the old)\n${messages || "(no new messages)"}`
        : `## Thread so far, oldest first (NEW = arrived, or edited by its author, since your last turn)\n${messages || "(no messages yet)"}`,
      noteText ? `## Notes from the coordinator (people can open each under a one-line marker in the thread)\n${noteText}` : "",
      ...tail,
    ]
      .filter(Boolean)
      .join("\n\n");
  };
  return fitPrompt(render, { history: history.length, notes: notes.length }, input.budget);
}

/**
 * The prompt within `budget` characters. A long thread's messages, coordinator notes and the like
 * were all repeated every turn, so it outgrew the runner's limit and the agent could not start;
 * the oldest messages go first, then the oldest notes, while the instructions, memory, brief and
 * the message the thread started from stay. A prompt still too long (one huge newest message)
 * keeps its start and its end.
 */
export function fitPrompt(
  render: (left: { history: number; notes: number }) => string,
  counts: { history: number; notes: number },
  budget = Number.POSITIVE_INFINITY,
): string {
  let prompt = render({ history: 0, notes: 0 });
  if (prompt.length <= budget) return prompt;
  // Keep the newest message: drop from the oldest, finding the fewest to leave out by halving.
  const fewest = (fits: (n: number) => boolean, max: number) => {
    let lo = 0;
    let hi = max;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fits(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const maxHistory = Math.max(0, counts.history - 1);
  const history = fewest((n) => render({ history: n, notes: 0 }).length <= budget, maxHistory);
  prompt = render({ history, notes: 0 });
  if (prompt.length <= budget) return prompt;
  const notes = fewest((n) => render({ history, notes: n }).length <= budget, counts.notes);
  prompt = render({ history, notes });
  if (prompt.length <= budget) return prompt;
  const cut = "\n\n(…part of this prompt is cut here to keep it within its size limit…)\n\n";
  const tail = Math.floor((budget - cut.length) / 3);
  return `${prompt.slice(0, budget - cut.length - tail)}${cut}${prompt.slice(-tail)}`;
}

function renderPullRequest(pr: PullRequest): string {
  const ci = pr.checks === null ? "no CI" : pr.checks === "success" ? "CI passing" : pr.checks === "failure" ? "CI failing" : "CI running";
  const review = pr.review === "approved" ? ", approved" : pr.review === "changes_requested" ? ", changes requested" : "";
  return `- ${pr.repo}#${pr.number} "${pr.title}" ${pr.url}: ${pr.draft && pr.state === "open" ? "draft" : pr.state}, ${ci}${review}`;
}

/** The message body of a choice card: its context, then the card. */
export function decisionCard(decision: Decision, context?: string): string {
  return [context, formatDecision(decision)].filter(Boolean).join("\n\n");
}

/** A choice card as plain text, for the coordinator to read. */
export function renderQuestion(decision: Decision, context?: string): string {
  const options = decision.options.map(
    (o, i) => `  ${i + 1}. ${o.label}${o.consequence ? `: ${o.consequence}` : ""}${i === decision.recommended ? " (recommended)" : ""}`,
  );
  return [decision.question, ...options, context ? `  Context: ${context}` : ""].filter(Boolean).join("\n");
}

/** A reply past this many characters or lines should have been an artifact or a file. */
const LONG_REPLY_CHARS = 1500;
const LONG_REPLY_LINES = 15;

export function isLongReply(text: string): boolean {
  return text.length > LONG_REPLY_CHARS || text.trim().split("\n").length > LONG_REPLY_LINES;
}

export function threadTools(host: ThreadHost): Tool[] {
  return [
    tool({
      name: "reply",
      description: "Send a message in this thread. Markdown is supported.",
      input: z.object({
        text: z.string().min(1).max(32_000),
        needs: z
          .enum(["decision", "blocked", "review"])
          .optional()
          .describe(
            "decision: asks people to choose or approve. blocked: stuck on something only they can change. review: presents something (a proposal, a draft, an artifact) and waits for their feedback.",
          ),
        files: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Project file paths to attach (files you made, e.g. reports/summary.xlsx); upload them first."),
      }),
      run: async ({ text, needs, files }) => {
        await host.reply(text, needs, files);
        // Long replies make threads hard to scroll; sending it anyway and nudging keeps the turn going.
        const tooLong = isLongReply(text)
          ? " That reply was long: keep the next ones to a few sentences, put longer content in an artifact or a project file, and ask for choices with ask_decision."
          : "";
        // Weaker models read their opening note as the end of the turn; it is not. Some also skip
        // the plan and only set it once the work is done, when people no longer need it.
        if (!needs && !host.planned())
          return `Sent.${tooLong} Unless that reply finished the turn, call update_plan next, before any other tool, so people follow your plan while you work.`;
        return `Sent.${tooLong}`;
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
        if (active > 1) return "Plan updated. Note: more than one step is active; keep only the one you are on active.";
        // Weaker models set the plan up front and then tick every step at the very end.
        if (plan.steps.some((s) => s.state === "todo" || s.state === "active"))
          return "Plan updated. As soon as the active step's work is done, call update_plan again to mark it done and the next one active, before you start that next step.";
        return "Plan updated.";
      },
    }),
    tool({
      name: "ask_decision",
      description:
        "Ask the person to choose, shown as a card with buttons. Options: 2 to 4, each a 1-2 word label and a one-sentence consequence. Mark one as recommended (0-based index). The coordinator sees it first and answers it when the project's memory, instructions or an earlier decision already settle it; otherwise the card goes to the person.",
      input: Decision.extend({
        context: z.string().max(1200).optional(),
        ask_person: z
          .boolean()
          .optional()
          .describe(
            "Skip the coordinator: only the person can answer (they asked to be asked, it approves something that cannot be undone, or it is about taste or work they must look at).",
          ),
      }),
      run: async ({ context, ask_person, ...decision }) => {
        const to = await host.askDecision({ decision, context, askPerson: ask_person ?? false });
        return to === "person"
          ? "Asked. The person's choice will arrive as their next message."
          : "Sent to the coordinator first. Its answer, or the person's choice if it passes the card on, arrives in a later turn. Carry on with the recommended option if you can; otherwise end your turn.";
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
      name: "request_repo_connection",
      description:
        "Ask the person to connect a GitHub repository this project has not connected (to push to it or open a pull request). Posts a card; one tap by a project owner or admin connects it through Myrel's GitHub App, and you are woken to carry on. End your turn after calling it.",
      input: z.object({
        repo: z.string().min(3).max(200).regex(/^[\w.-]+\/[\w.-]+$/).describe("owner/name"),
        reason: z.string().min(1).max(300).describe("One sentence, in the person's language, on what you need it for."),
      }),
      run: ({ repo, reason }) => host.requestRepo(repo, reason),
    }),
    tool({
      name: "open_pull_request",
      description:
        "Open a pull request on a connected repository through Myrel's GitHub App, after you pushed its branch. It needs no GitHub sign-in or gh on your side, credits the person this thread works for with a link back here, and follows the pull request like track_pull_request. If the branch already has an open pull request, that one is returned.",
      input: z.object({
        repo: z.string().min(1).describe("owner/name, one of the connected repositories"),
        head: z.string().min(1).max(255).describe("The pushed branch with the changes."),
        base: z.string().max(255).optional().describe("The branch to merge into. Defaults to the repository's default branch."),
        title: z.string().min(1).max(256),
        body: z.string().max(60000).optional().describe("What changed and why, in Markdown. Myrel adds the credit line on top itself."),
        draft: z.boolean().optional(),
      }),
      run: (input) => host.openPullRequest(input),
    }),
    tool({
      name: "close_pull_request",
      description:
        "Close, without merging, a pull request this thread opened (open_pull_request), when the person asks or the work no longer needs it. The reason goes on it as a comment. A merged pull request cannot be closed, nor one the thread only follows. The branch stays unless delete_branch: then a card asks the person whether to delete it.",
      input: z.object({
        url: z.string().url().describe("The pull request's github.com link."),
        reason: z.string().trim().min(1).max(1000).describe("Why it is closed, in the person's language; posted on the pull request."),
        delete_branch: z.boolean().default(false).describe("Ask the person, with a card, whether to delete its branch too."),
      }),
      run: ({ url, reason, delete_branch }) => host.closePullRequest({ url, reason, deleteBranch: delete_branch }),
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
      description:
        "Mark this thread finished. Call it after the reply that delivers the result, once nothing waits on the person: not in a turn that asked them something or presented a proposal, draft or artifact for their feedback.",
      input: z.object({}),
      run: async () => {
        const refused = await host.resolve();
        if (refused) return refused;
        return { output: "Thread resolved.", stop: true };
      },
    }),
  ];
}

/** A person changed the message's text after the given time (the agent's last turn). */
export function editedSince(m: Message, since: string | undefined): boolean {
  return !!since && !!m.editedAt && m.editedAt > since;
}

/**
 * People's messages that arrived while the turn runs, added to the result of its next Myrel tool
 * call. People see them as delivered from then on, and the next turn does not show them as NEW.
 */
export function newsNote(messages: Message[], names: Record<string, string>, edited: Message[] = []): string {
  const many = messages.length > 1;
  const news = messages.length
    ? [
        `## ${many ? "New messages" : "A new message"} in this thread while you work`,
        `${many ? "They arrived" : "It arrived"} after this turn started; people see ${many ? "them" : "it"} as delivered to you now. Take ${many ? "them" : "it"} into account from here on: ${many ? "they" : "it"} may change, add to or stop the work. When ${many ? "they ask" : "it asks"} something, answer with reply.`,
        ...messages.map((m) => renderMessage(m, names, { isNew: true })),
      ]
    : [];
  const changed = edited.length
    ? [
        `## ${edited.length > 1 ? "Messages" : "A message"} edited in this thread while you work`,
        `A person changed ${edited.length > 1 ? "these earlier messages" : "this earlier message"} after this turn started; the new text replaces the old. Take it into account from here on.`,
        ...edited.map((m) => renderMessage(m, names, { isNew: true })),
      ]
    : [];
  return [...news, ...changed].join("\n\n");
}
