import {
  type AgentConnector,
  type Attachment,
  type ArtifactRef,
  CLI_NAMES,
  CloudCli,
  type CliUsage,
  type ConnectorOffer,
  type ConnectorSuggestion,
  createId,
  formatConnectorSuggestion,
  formatPlan,
  formatPlanUpdate,
  type PlanUpdate,
  type ProjectWorkspace,
  type MarkMemoryInput,
  type Message,
  type MessageStats,
  type SkillBundle,
  type Task,
  type TaskStatus,
  type TerminalLine,
  type ThreadModel,
} from "@myrel/protocol";
import {
  emptyProgress,
  reduceTask,
  renderChecklist,
  type RunnerBackend,
  type McpConnector,
  type RunnerEvent,
  type TaskProgress,
  TaskSpec,
  workingBranch,
} from "@myrel/runner-core";
import { createDb, schema } from "@myrel/db";
import { Agent, getAgentByName } from "agents";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { readSecrets, refreshStaleTools, remoteTarget, type TurnConnector, turnConnectors } from "../connectors/store";
import { findOffers, knownConnectors, searchOffers } from "../connectors/suggest";
import { fromBase64, readBundle, tameSkillMd, toBase64, type TurnSkill, turnSkills } from "../skills/store";
import { canUseSandbox } from "../extensions";
import { revokeInstallationToken } from "../github/app";
import { listRepoFiles, readRepoFile } from "../github/files";
import type { PullCredit } from "../github/attribution";
import {
  CONFLICT_RETRY_SEC,
  type ConflictCheck,
  checkConflict,
  closePullRequest,
  deletePullBranch,
  listPullRequests,
  openPullRequest,
  trackPullRequest,
} from "../github/pulls";
import { connectRepoByName, githubLogin, listProjectRepos } from "../github/store";
import { projectTaskModel } from "../keys";
import { handleMcp, type Tool, tool } from "../llm";
import { getWorkspace, runnerHasFeature, setWorkspaceFolder, workspaceClis } from "../runners";
import { cloudHarness, localBackend, localCanceller, localGithubToken, ownsComputer, projectCloudCli, projectGithubToken, sandboxBackend, type TaskPlace, taskPlace } from "../sandbox/backend";
import { readWorkspace, threadWorkspace, type WorkspaceView } from "../sandbox/workspace";
import { markSandboxActive, recordSandboxRun, recordTaskUsage, taskCostMicros, taskRuntime } from "../usage";
import { projectCliModels, resolveTaskModel } from "../task-model";
import { UNVERIFIED_MESSAGE, userVerified } from "../verification";
import {
  type AgentPlace,
  agentPrompt,
  hashAgentToken,
  newAgentToken,
  pullRequestUrls,
  SANDBOX_REPOS,
  sameHash,
  UNCHANGED_NOTE,
  unchangedSections,
} from "./harness-agent";
import {
  ACCESS_LEVEL_DENIED,
  ACCESS_WAIT_MS,
  type AccessAnswer,
  accessAnswer,
  accessMessage,
  type AccessRequest,
  accessTargets,
  allowAnswer,
  answeredAccessMessage,
  commandAnswer,
  commandMessage,
  denyAnswer,
  describeCommand,
  describeRequest,
  insideAny,
  opensPullRequest,
  USE_OPEN_PULL_REQUEST,
} from "./folder-access";
import { type Author, knowledgeTools, signFileLink } from "./knowledge";
import { suggestionTools } from "./connector-suggestions";
import { composeStatus, hasChanges, mergePlanUpdates, type Plan, planChanges } from "./plan";
import { decideResume, gaveUpMessage, interruptedReason, type ResumeState, type ResumeWhere, resumeNote, resumingMessage } from "./auto-resume";
import { SEEN_EMOJI, THREAD_AGENT_ID, SYSTEM_ID } from "./names";
import type { ThreadWake } from "./project-agent";
import { type BranchRequest, branchAnswer, branchBlockText, branchRequestMessage, branchResultMessage } from "./branch-request";
import { type RepoRequest, repoAnswer, repoConnectedMessage, repoFailureMessage, repoRequestMessage } from "./repo-request";
import { routineTools } from "./routine-tools";
import type { TaskWithLog } from "./thread-tasks";
import {
  type CoordinatorNote,
  decisionCard,
  editedSince,
  newsNote,
  type ReplyNeeds,
  type RoutineRun,
  renderQuestion,
  threadPrompt,
  threadTools,
} from "./thread-worker";

const BY: Author = { kind: "agent", id: THREAD_AGENT_ID };

export type ThreadStart = {
  projectId: string;
  threadId: string;
  brief: string;
  /**
   * Who a thread nobody asked for in the chat works for until someone writes in it: memory upkeep's
   * author, or the person behind the coordinator turn that opened it on its own message.
   */
  actor?: string | null;
};

/** A connector card the agent posted, and the message that shows it. */
type StoredSuggestion = ConnectorSuggestion & { messageId: string };

type NoteRow = { id: number; body: string; created_at: string; seen: number };

type TaskRow = {
  id: string;
  spec: string;
  backend: string;
  status: TaskStatus;
  progress: string;
  summary: string | null;
  pr_url: string | null;
  language: string;
  created_at: string;
  finished_at: string | null;
  reported: number;
};

/**
 * A run's spec as stored. Runs on the person's computer name their CLI (claude, codex…) as the harness.
 * agent: the run was one turn of the thread's agent. Older runs were tasks Myrel's own loop handed out.
 */
type StoredSpec = Omit<TaskSpec, "harness"> & { harness: string; runnerId?: string; computer?: string; agent?: boolean };

/** How far into the turn's run a message's stats line counted: when, and the run's usage by then. */
type StatsMark = { at: number; inputTokens: number; outputTokens: number; costUsd: number };

/** What the thread's agent did through Myrel's tools during its turn, kept until the turn ends. */
type AgentTurn = {
  pending: ArtifactRef[];
  replied: boolean;
  /** Its latest reply, for the notification. */
  lastReply?: string;
  needs: ReplyNeeds | null;
  asked: boolean;
  /** It put a choice card to the coordinator first (see PendingQuestion). */
  questioned?: boolean;
  resolved: boolean;
  timezone: string;
  /** The language of the person's latest message, for cards Myrel posts on the agent's behalf. */
  language?: string;
  /** Where the last stats line stopped counting; the next message's line starts here. Absent on older turns. */
  mark?: StatsMark;
  /** Its latest reply and where that reply's line started, so the usage after it can join it when the turn ends. */
  lastReplyStats?: { id: string; from: StatsMark };
  /** Every step of the plan it set this turn is settled (none to do or active). */
  planDone?: boolean;
  /** When it replied with its plan done; the turn ends a minute later unless it moves on. */
  doneReplyAt?: number;
  /** It published an artifact this turn, which people have not answered yet. */
  published?: boolean;
};

/** The louder of what two replies wait on: a decision or a block outranks a review. */
function louder(a: ReplyNeeds | null | undefined, b: ReplyNeeds | null | undefined): ReplyNeeds | null {
  if (!a || !b) return a ?? b ?? null;
  return a === "review" ? b : a;
}

/** The GitHub branch where a cloud turn leaves the unpushed work of the repositories it cloned. */
function saveBranch(threadId: string): string {
  return `myrel/saved/${threadId}`;
}

/** The runner protocol's limit for a task's prompt, less room for the agent's instructions. */
const MAX_AGENT_PROMPT = 90_000;
/** How long one agent turn may run. */
const AGENT_TURN_SEC = 3600;
/** A turn on a person's computer gets a new GitHub token this often; each lasts an hour. */
const GITHUB_RENEW_SEC = 45 * 60;
/**
 * After the agent replied with its plan done, how long its harness may keep going before the turn
 * is ended for it (some models keep calling tools after their last reply).
 */
const FINISH_AFTER_REPLY_SEC = 60;
/** How long a choice card waits on the coordinator before it goes to the person anyway. */
const QUESTION_TIMEOUT_SEC = 120;

/** A choice card the agent asked that waits on the coordinator: answered there, or passed on to people. */
type PendingQuestion = { id: string; card: string; question: string };

type LogRow = { stream: TerminalLine["stream"]; text: string; at: number | null; ms: number | null; tool: number | null };

/** Terminal lines kept per task; older ones are dropped. */
const MAX_LOG_LINES = 2000;
/** A run on the person's computer has no sandbox, clone or pull request steps; its CLI just works. */
const LOCAL_PHASES: RunnerEvent[] = [
  { type: "phase", phase: "prepare", state: "skipped" },
  { type: "phase", phase: "clone", state: "skipped" },
  { type: "phase", phase: "publish", state: "skipped" },
  { type: "phase", phase: "agent", state: "started" },
];
/** Attached files a cloud turn downloads before the agent starts; older ones it fetches with read_file. */
const PREFETCH_MAX_FILES = 20;
const PREFETCH_MAX_BYTES = 200 * 1024 * 1024;
/** Extra time after a run's own timeout before it is declared lost (its runner went away). */
const WATCHDOG_GRACE_SEC = 300;
/** How often a running cloud turn checks that its sandbox is still on it (a deploy restarts sandboxes). */
const SANDBOX_CHECK_SEC = 60;
/** Why a cloud turn ended when its sandbox lost it. */
const SANDBOX_LOST = "The sandbox stopped while working, most likely because a new version of Myrel was deployed. Send your message again to continue.";

/**
 * One instance per thread (named by thread id). Each wake queues a turn of the
 * thread's agent: a coding harness (see harness-agent.ts) that gets the thread
 * as its prompt and acts through Myrel's tools over MCP (agentMcp). Messages
 * themselves live in the ProjectAgent; this DO keeps the brief, coordinator
 * notes, a read cursor, and each turn's run (on the person's computer or in
 * the sandbox) with its progress and terminal output.
 */
export class ThreadAgent extends Agent<Env> {
  /**
   * The GitHub tokens each running local turn was handed, to revoke when it ends. Only in memory:
   * after a restart a token is not revoked early, and it still expires within the hour.
   */
  private readonly githubTokens = new Map<string, string[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0
    )`;
    this.migrateLocalTasks();
    this.sql`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      spec TEXT NOT NULL,
      backend TEXT NOT NULL,
      status TEXT NOT NULL,
      progress TEXT NOT NULL,
      summary TEXT,
      pr_url TEXT,
      language TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL,
      finished_at TEXT,
      reported INTEGER NOT NULL DEFAULT 0
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS task_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      text TEXT NOT NULL,
      at INTEGER,
      ms INTEGER,
      tool INTEGER
    )`;
    this.migrateLogTimes();
    this.sql`CREATE TABLE IF NOT EXISTS github_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS routine_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0
    )`;
    // Who a run works for came later; older threads gain the column.
    if (!this.sql<{ name: string }>`PRAGMA table_info(routine_runs)`.some((c) => c.name === "actor")) {
      this.sql`ALTER TABLE routine_runs ADD COLUMN actor TEXT`;
    }
    // Likewise who a forwarded ask is for (forwarded = 1; actor null when not one known person).
    if (!this.sql<{ name: string }>`PRAGMA table_info(notes)`.some((c) => c.name === "forwarded")) {
      this.sql`ALTER TABLE notes ADD COLUMN forwarded INTEGER NOT NULL DEFAULT 0`;
      this.sql`ALTER TABLE notes ADD COLUMN actor TEXT`;
    }
  }

  /** Called by the ProjectAgent when the coordinator opens this thread. */
  async start(input: ThreadStart): Promise<void> {
    this.setMeta("project_id", input.projectId);
    this.setMeta("thread_id", input.threadId);
    this.setMeta("brief", input.brief);
    if (input.actor) this.setMeta("start_actor", input.actor);
    await this.markDirty();
  }

  /**
   * A person wrote in the thread, the coordinator sent a note, a routine ran, or one of the
   * thread's pull requests changed on GitHub. Task results come through taskEvents.
   */
  async wake(reason: ThreadWake): Promise<void> {
    // Someone writing in a closed thread, the coordinator sending it work or a routine resumed for it opens it again.
    if (reason.kind !== "github") this.deleteMeta("closed");
    if (reason.kind !== "github" && reason.reopened) this.startPlanRound();
    // An answer to a folder card the running turn waits on goes to that turn, not to a new one.
    if (reason.kind === "message" && reason.body !== undefined && (await this.answerAccess(reason))) return;
    // A tap on the repository card connects it first, so the turn it starts has it.
    if (reason.kind === "message" && reason.body !== undefined && (await this.answerRepoRequest(reason))) return;
    // A tap on the branch card deletes it (or keeps it) without a turn.
    if (reason.kind === "message" && reason.body !== undefined && (await this.answerBranchRequest(reason))) return;
    if (reason.kind === "coordinator") {
      const forwarded = reason.forwardedFor !== undefined;
      this.sql`INSERT INTO notes (body, created_at, forwarded, actor)
        VALUES (${reason.note}, ${new Date().toISOString()}, ${forwarded ? 1 : 0}, ${reason.forwardedFor ?? null})`;
    }
    if (reason.kind === "github" && reason.settled && this.getMeta("thread_id") && !this.runningTask() && !this.planHasWork()) {
      // A merge or close with nothing left to do: said here and settled without starting the agent.
      this.sql`INSERT INTO github_events (body, created_at, seen) VALUES (${reason.event}, ${new Date().toISOString()}, 1)`;
      return this.pullRequestSettled(reason.settled);
    }
    if (reason.kind === "github") {
      this.sql`INSERT INTO github_events (body, created_at) VALUES (${reason.event}, ${new Date().toISOString()})`;
    }
    if (reason.kind === "routine") {
      this.sql`INSERT INTO routine_runs (name, prompt, created_at, actor)
        VALUES (${reason.name}, ${reason.prompt}, ${new Date().toISOString()}, ${reason.actor ?? null})`;
    }
    // What the next turn is for: a running turn that takes in the new messages (takeNews) needs no
    // next turn for them, but still does for anything else.
    if (reason.kind === "message" && !reason.edited && reason.seq !== undefined) {
      this.setMeta("wake_seq", String(Math.max(reason.seq, Number(this.getMeta("wake_seq") ?? 0))));
    } else this.setMeta("wake_other", "1");
    await this.markDirty();
  }

  /**
   * A resolved thread got new work: the next plan opens a new card at the end of the conversation,
   * under the message that asked for it, instead of growing the finished card further up. The old
   * card keeps its last state, and the thread shows the old plan until the agent sets a new one.
   */
  private startPlanRound() {
    for (const key of ["plan", "plan_card_id", "plan_card_text", "plan_update_id", "plan_update"]) this.deleteMeta(key);
    this.setMeta("plan_finished", "1");
  }

  /** The plan the agent set has steps still to do. */
  private planHasWork(): boolean {
    const plan = this.getMeta("plan");
    return plan ? (JSON.parse(plan) as Plan).steps.some((s) => s.state === "todo" || s.state === "active") : false;
  }

  /**
   * One of the thread's pull requests was merged or closed while nothing is left to do: one line in
   * the thread, and the thread is resolved once none of its pull requests is open. No agent turn,
   * so no sandbox starts for it.
   */
  private async pullRequestSettled(settled: { pr: string; merged: boolean }) {
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const tr = this.getMeta("language") === "tr";
    const body = settled.merged
      ? tr ? `${settled.pr} birleştirildi.` : `${settled.pr} was merged.`
      : tr ? `${settled.pr} birleştirilmeden kapatıldı.` : `${settled.pr} was closed without merging.`;
    const m = await project.sendMessage({ threadId, authorKind: "system", authorId: SYSTEM_ID, body });
    if (m.seq === Number(this.getMeta("last_seen_seq") ?? 0) + 1) this.setMeta("last_seen_seq", String(m.seq));
    const open = (await listPullRequests(this.env.DB, projectId, threadId)).some((pr) => pr.state === "open");
    if (open) return;
    await project.updateThread(threadId, { status: "done", resolved: true });
    await project.notifyThread(threadId, "done", body);
  }

  /** The choice card waiting on the coordinator, taken off the wait when its id matches. */
  private takeQuestion(id: string): PendingQuestion | null {
    const raw = this.getMeta("pending_question");
    const q = raw ? (JSON.parse(raw) as PendingQuestion) : null;
    if (q?.id !== id) return null;
    this.deleteMeta("pending_question");
    return q;
  }

  /**
   * The coordinator answered the agent's choice card itself, so the card never reaches people.
   * Returns the question, or null when the card was already answered or passed on. Callable over RPC.
   */
  async answeredQuestion(id: string): Promise<{ question: string } | null> {
    const q = this.takeQuestion(id);
    return q && { question: q.question };
  }

  /**
   * The choice card goes to people after all: the coordinator passed it on (with an optional line of
   * what it knows), its turn failed, or it took too long. Returns false when the card was already
   * answered or passed on. Callable over RPC.
   */
  async escalateQuestion(id: string, note?: string): Promise<boolean> {
    const q = this.takeQuestion(id);
    if (!q) return false;
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const body = note?.trim() ? `${note.trim()}\n\n${q.card}` : q.card;
    const m = await project.sendMessage({ threadId, authorKind: "agent", authorId: THREAD_AGENT_ID, body });
    if (m.seq === Number(this.getMeta("last_seen_seq") ?? 0) + 1) this.setMeta("last_seen_seq", String(m.seq));
    const turn = JSON.parse(this.getMeta("agent_turn") ?? "null") as AgentTurn | null;
    if (this.runningTask() && turn) {
      // A turn still running says it when it ends, so the thread does not read "working" over the card.
      this.setMeta("agent_turn", JSON.stringify({ ...turn, needs: louder("decision", turn.needs), lastReply: q.question }));
    } else {
      await project.updateThread(threadId, { status: "review_ready" });
      await project.notifyThread(threadId, "decision", q.question);
    }
    return true;
  }

  /** Schedule callback: a choice card still waiting on the coordinator goes to the person. */
  async questionTimeout(payload: { id: string }): Promise<void> {
    if (this.getMeta("closed")) return;
    await this.escalateQuestion(payload.id);
  }

  /**
   * The thread was closed as opened by mistake (ProjectAgent.closeThread). Its running turn stops
   * and what that turn would still have said or set is dropped. Callable over RPC.
   */
  async close(): Promise<void> {
    this.setMeta("closed", "1");
    this.deleteMeta("pending_question");
    this.deleteMeta("branch_request");
    this.setMeta("dirty", "0");
    await this.cancelRunningTask();
  }

  private async markDirty() {
    this.setMeta("dirty", "1");
    await this.queue("threadTurn", null);
  }

  /** Queue callback. Turns run one at a time; wakes during a turn get their own turn after it. */
  async threadTurn(): Promise<void> {
    if (this.getMeta("dirty") !== "1" || this.getMeta("closed") === "1") return;
    // The agent is mid-turn; this wake waits for it (finishAgentTurn queues the next turn).
    if (this.runningTask()) return;
    this.setMeta("dirty", "0");
    this.deleteMeta("wake_other");
    const projectId = this.getMeta("project_id");
    const threadId = this.getMeta("thread_id");
    if (!projectId || !threadId) return;

    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const ctx = await project.getThreadContext(threadId);
    if (!ctx) return;

    // The person the thread works for: their own connectors are on for it, and only their own computer.
    // A routine's run works for the routine's author instead, unless someone wrote since the last turn.
    const lastSeen = Number(this.getMeta("last_seen_seq") ?? 0);
    const wroteSince = ctx.messages.some((m) => m.authorKind === "user" && m.seq > lastSeen);
    const [routineActor] = this.sql<{ actor: string }>`SELECT actor FROM routine_runs WHERE seen = 0 AND actor IS NOT NULL ORDER BY id DESC LIMIT 1`;
    // An ask the coordinator forwarded from the project chat works for whoever asked it there, not
    // for whoever wrote in this thread before (null: not one known person, so nobody's own).
    // Notes that arrive while this turn is put together wait for the next one, so the turn never
    // takes an ask it did not decide who works for.
    const noteCut = this.sql<{ id: number | null }>`SELECT MAX(id) AS id FROM notes`[0]?.id ?? 0;
    const forwarded = this.sql<{ actor: string | null }>`SELECT actor FROM notes WHERE seen = 0 AND forwarded = 1 AND id <= ${noteCut} ORDER BY id`;
    const lastWriter = [ctx.root, ...ctx.messages].reverse().find((m) => m.authorKind === "user")?.authorId ?? null;
    const forwardedActors = new Set(forwarded.map((n) => n.actor));
    const forwardedFor = forwardedActors.size === 1 ? [...forwardedActors][0]! : null;
    const member = async (id: string | null) => (id && (await isMember(this.env, projectId, id)) ? id : null);
    const requester = forwarded.length
      ? // Someone also wrote here since: only when it is the same person does the turn work for them.
        !wroteSince || lastWriter === forwardedFor
        ? await member(forwardedFor)
        : null
      : !wroteSince && routineActor
        ? await member(routineActor.actor)
        : // Someone who has left the project since writing here gets no more turns.
          await member(lastWriter ?? (this.getMeta("start_actor") || null));
    this.setMeta("requester", requester ?? "");
    const place = await taskPlace(this.env, projectId, requester, ctx.thread.cli?.id, ctx.thread.runner);
    if (place.kind === "error") return this.cannotWork(place.message);
    // The container takes the longest to be ready, so it starts while the turn is put together.
    if (place.kind === "cloud" && this.env.SANDBOX && (await canUseSandbox(this.env, projectId)).ok) {
      this.ctx.waitUntil(this.env.SANDBOX.getByName(threadId).warm().catch((err) => console.warn("sandbox warm-up failed", err)));
    }
    // Runners before 0.5.0 can host only Claude Code as the agent.
    const needs = place.kind === "local" && place.workspace.cli !== "claude" ? "agent-clis" : "agent";
    if (place.kind === "local" && !(await runnerHasFeature(this.env, place.workspace.runnerId, needs))) {
      return this.cannotWork(
        `myrel-runner on "${place.workspace.runnerName}" is too old to work this thread. Update it with \`npx myrel-runner@latest update\`, then write here again.`,
      );
    }

    const noteRows = this.sql<NoteRow>`SELECT * FROM notes WHERE id <= ${noteCut} ORDER BY id`;
    const notes: CoordinatorNote[] = noteRows.map((n) => ({ body: n.body, createdAt: n.created_at, isNew: n.seen === 0 }));
    const lastSeenSeq = Number(this.getMeta("last_seen_seq") ?? 0);
    const lastSeenAt = this.getMeta("last_seen_at") ?? undefined;
    // Only the last few runs matter; older ones are history the thread already acted on.
    const runRows = this.sql<NoteRow & { name: string; prompt: string }>`
      SELECT * FROM (SELECT * FROM routine_runs ORDER BY id DESC LIMIT 5) ORDER BY id`;
    const routineRuns: RoutineRun[] = runRows.map((r) => ({
      name: r.name,
      prompt: r.prompt,
      createdAt: r.created_at,
      isNew: r.seen === 0,
    }));
    // Only the last few events matter; the pull requests' current state is listed separately.
    const githubRows = this.sql<NoteRow>`SELECT * FROM (SELECT * FROM github_events ORDER BY id DESC LIMIT 10) ORDER BY id`;
    const githubEvents: CoordinatorNote[] = githubRows.map((g) => ({ body: g.body, createdAt: g.created_at, isNew: g.seen === 0 }));
    this.sql`UPDATE notes SET seen = 1 WHERE id <= ${noteCut}`;
    this.sql`UPDATE routine_runs SET seen = 1`;
    this.sql`UPDATE github_events SET seen = 1`;
    this.setMeta("last_seen_seq", String(ctx.messages.at(-1)?.seq ?? lastSeenSeq));
    this.setMeta("last_seen_at", new Date().toISOString());
    // People see that the agent took in the message they changed.
    for (const m of ctx.messages) {
      if (m.authorKind === "user" && editedSince(m, lastSeenAt)) {
        await project.addReaction({ messageId: m.id, emoji: SEEN_EMOJI, authorKind: "agent", authorId: THREAD_AGENT_ID });
      }
    }
    const promptInput = {
      ...ctx,
      brief: this.getMeta("brief") ?? "",
      lastSeenSeq,
      lastSeenAt,
      notes,
      artifacts: await project.listArtifacts(),
      repos: await listProjectRepos(this.env.DB, projectId),
      routineRuns,
      githubEvents,
      pullRequests: await listPullRequests(this.env.DB, projectId, threadId),
      now: new Date(),
    };
    const lastHuman = [...ctx.messages].reverse().find((m) => m.authorKind === "user") ?? ctx.root;
    // This turn continues one a runner restart cut off, whether its wait ran out or a message came first.
    const pending = JSON.parse(this.getMeta("resume_pending") ?? "null") as { resumes: number; lastStep: string | null; where?: ResumeWhere } | null;
    this.deleteMeta("resume_pending");
    const note = { ...(pending ? { resumeNote: resumeNote(pending) } : {}), planFinished: this.getMeta("plan_finished") === "1" };
    // What a resumed CLI session got on its last turn: it holds those sections already.
    const seen = JSON.parse(this.getMeta("agent_prompt_seen") ?? "null") as { task: string; hashes: string[] } | null;
    const unchanged = unchangedSections(seen && seen.task === this.getMeta("agent_last_task") ? seen.hashes : []);
    await this.startAgentTurn({
      prompt: threadPrompt({ ...promptInput, ...note }),
      followUp: { prompt: threadPrompt({ ...promptInput, followUp: true, ...note, lasting: unchanged.lasting }), unchanged },
      requester,
      place,
      timezone: ctx.defaultTimezone,
      language: /[çğıöşüÇĞİÖŞÜ]/.test(lastHuman.body) ? "tr" : "en",
      attachments: [ctx.root, ...ctx.messages].flatMap((m) => m.attachments ?? []),
      threadModel: ctx.thread.model,
      threadCli: ctx.thread.cli?.id ?? null,
      threadRunner: ctx.thread.runner?.id ?? null,
    });
  }

  /** Nothing can work this thread right now: say why, and wait for the person. */
  private async cannotWork(reason: string) {
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    await project.sendMessage({ threadId, authorKind: "system", authorId: SYSTEM_ID, body: reason });
    await project.updateThread(threadId, { status: "blocked" });
    await project.notifyThread(threadId, "blocked", reason);
  }

  /**
   * Hands this turn to the thread's agent, connected to this thread's MCP endpoint with a token that
   * lives as long as the turn: the person's CLI on their computer, or OpenCode in the thread's sandbox.
   */
  private async startAgentTurn(input: {
    prompt: string;
    /**
     * The same, with only what is new since the last turn, for a CLI session that continues it:
     * sections it holds unchanged from then are left out (see unchangedSections).
     */
    followUp: { prompt: string; unchanged: ReturnType<typeof unchangedSections> };
    place: Exclude<TaskPlace, { kind: "error" }>;
    timezone: string;
    language: string;
    /** Files attached to the thread's messages, oldest first: a cloud turn finds them already downloaded. */
    attachments: Attachment[];
    /** Who the thread works for, whose own connectors it may use. */
    requester: string | null;
    /** The model and effort picked for the thread, if any (see resolveTaskModel). */
    threadModel: ThreadModel | null;
    /** The computer the thread was set to or first ran on, if any. */
    threadRunner?: string | null;
    /** The CLI picked for the thread, if any: in the cloud, one of CloudCli replaces the project's. */
    threadCli: string | null;
  }) {
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const { place, language } = input;
    const { token, hash } = await newAgentToken();
    // Git on the person's computer clones and pushes the project's repositories with a token of the turn's own.
    const github = place.kind === "local" ? await localGithubToken(this.env, projectId, place.workspace.runnerId, input.requester) : null;
    const agentPlace: AgentPlace =
      place.kind === "local"
        ? {
            kind: "local",
            cli: place.workspace.cli,
            folder: place.workspace.path,
            folders: place.workspace.folders,
            computer: place.workspace.runnerName,
            asks: place.workspace.cli === "claude" && (await runnerHasFeature(this.env, place.workspace.runnerId, "project-folders")),
            github: !!github,
          }
        : { kind: "cloud", images: false, saveBranch: saveBranch(threadId) };
    // A very long thread keeps its newest part; a resumed CLI session remembers the rest.
    const context = input.prompt.length > MAX_AGENT_PROMPT ? `(older context cut)\n${input.prompt.slice(-MAX_AGENT_PROMPT)}` : input.prompt;
    const taskId = createId("task");
    if (github) this.githubTokens.set(taskId, [github.token]);
    // The turn a resumed CLI session last saw; the runner resumes with the short prompt only after it.
    const previousTask = this.getMeta("agent_last_task");
    this.setMeta("agent_last_task", taskId);
    const turn: AgentTurn = {
      pending: [],
      replied: false,
      needs: null,
      asked: false,
      resolved: false,
      timezone: input.timezone,
      language,
      mark: { at: Date.now(), inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
    this.setMeta("agent_turn", JSON.stringify(turn));
    // Lines Myrel writes in the thread between turns follow the person's language.
    this.setMeta("language", language);
    this.clearAccess();
    // Until the runner says where the CLI really works (a worktree, say), the project's folders.
    if (place.kind === "local") this.setMeta("access_folders", JSON.stringify([place.workspace.path, ...place.workspace.folders]));
    this.setMeta("agent_token", hash);
    this.deleteMeta("task_checklist");
    // People's messages up to here are this turn's; any after it show as waiting for the agent.
    await project.updateThread(threadId, { status: "working", seenSeq: Number(this.getMeta("last_seen_seq") ?? 0) });
    await project.setActivity(threadId, true);
    try {
      const mcpPath = `/api/agent-mcp/${threadId}`;
      const connectors = await this.turnConnectors(place, input.requester);
      const infos = connectors.map((c) => ({ name: c.name, title: c.title }));
      const skills = await this.turnSkills(place, input.requester);
      const spec = TaskSpec.parse({ taskId, title: "OpenCode", prompt: agentPrompt(agentPlace, context, infos, skills), timeoutSec: AGENT_TURN_SEC });
      // The stored spec keeps only the start of the prompt; the runner gets all of it.
      const stored = (s: TaskSpec, extra: Partial<StoredSpec> = {}): StoredSpec => ({ ...s, prompt: s.prompt.slice(0, 4000), agent: true, ...extra });
      if (place.kind === "local") {
        const { workspace } = place;
        const local: AgentConnector[] = await Promise.all(
          connectors.map(async (c): Promise<AgentConnector> =>
            c.transport === "http"
              ? { transport: "http", name: c.name, path: `${mcpPath}/c/${c.name}` }
              : { transport: "stdio", name: c.name, command: c.command!, args: c.args ?? [], env: await readSecrets(this.env, { id: c.id, secret: c.secret }) },
          ),
        );
        const { unchanged } = input.followUp;
        const short = agentPrompt(agentPlace, input.followUp.prompt, infos, skills, unchanged.lasting);
        // A session that resumes holds this turn's sections from now on, unless the thread was cut to fit.
        this.setMeta("agent_prompt_seen", JSON.stringify({ task: taskId, hashes: context === input.prompt ? unchanged.hashes : [] }));
        const resume =
          previousTask && input.followUp.prompt.length <= MAX_AGENT_PROMPT
            ? { after: previousTask, prompt: unchanged.left() ? `${UNCHANGED_NOTE}\n\n${short}` : short }
            : undefined;
        const agent = {
          mcpPath,
          token,
          ...(local.length && { connectors: local }),
          ...(skills.length && { skills: { path: `${mcpPath}/skills` } }),
          ...(resume && { resume }),
        };
        const installed = (await workspaceClis(this.env, projectId, { runnerId: workspace.runnerId }))?.clis.find((c) => c.id === workspace.cli);
        const model = resolveTaskModel(workspace.cli, input.threadModel, await projectCliModels(this.env, projectId), installed);
        const backend = localBackend(this.env, { projectId, threadId, workspace, agent, model, github });
        const unavailable = backend.unavailable(spec);
        if (unavailable) throw new Error(unavailable);
        // The person's own CLI does the work, so the run shows that CLI.
        const run = { ...spec, title: CLI_NAMES[workspace.cli] };
        await this.launch(stored(run, { harness: workspace.cli, runnerId: workspace.runnerId, computer: workspace.runnerName }), backend.id, () => backend.start(run, {}), language);
        await this.taskEvents(taskId, LOCAL_PHASES);
        // Its CLI session and uncommitted work are on this computer now: later turns stay here.
        if (input.threadRunner !== workspace.runnerId) await project.updateThread(threadId, { runner: { id: workspace.runnerId, by: "auto", reason: null } });
        if (github && this.runningTask()?.id === taskId) await this.schedule(GITHUB_RENEW_SEC, "renewGithub", { taskId, requester: input.requester });
      } else {
        // The sandbox costs the service and holds the project's tokens: not for an address nobody has shown is theirs.
        if (input.requester && !(await userVerified(this.env, input.requester))) throw new Error(UNVERIFIED_MESSAGE);
        const allowed = await canUseSandbox(this.env, projectId);
        if (!allowed.ok) throw new Error(allowed.reason);
        const origin = await project.publicOrigin();
        if (!origin) throw new Error("This server does not know its own address yet, so the sandbox cannot reach it. Its admin needs to set BETTER_AUTH_URL.");
        const model = await projectTaskModel(this.env, projectId);
        if (!model.ok) throw new Error(model.reason);
        // The model is reached through Myrel (see modelCaller), so no key, the server's or a member's
        // own, ever enters the sandbox, and an OpenAI-compatible call's cost is counted.
        spec.model = { ...model.model, baseUrl: `${origin}${mcpPath}/model` };
        const picked = CloudCli.safeParse(input.threadCli);
        const harness = cloudHarness(picked.success ? picked.data : await projectCloudCli(this.env, projectId), model.model);
        spec.harness = harness.id;
        spec.title = harness.title;
        spec.prompt = agentPrompt(
          { kind: "cloud", images: model.model.images ?? false, saveBranch: saveBranch(threadId), harness: harness.id },
          context,
          infos,
          skills,
        );
        spec.saveRepos = { dir: SANDBOX_REPOS, branch: saveBranch(threadId) };
        if (skills.length) spec.skills = { url: `${origin}${mcpPath}/skills` };
        const secrets: Record<string, string> = { MYREL_MODEL_API_KEY: token, MYREL_MCP_TOKEN: token };
        // A command's variables travel as secrets, so the stored spec only names them.
        const cloud: McpConnector[] = await Promise.all(
          connectors.map(async (c, i): Promise<McpConnector> => {
            if (c.transport === "http") return { transport: "http", name: c.name, url: `${origin}${mcpPath}/c/${c.name}` };
            const vars = Object.entries(await readSecrets(this.env, { id: c.id, secret: c.secret }));
            const env: Record<string, string> = {};
            vars.forEach(([name, value], j) => {
              env[name] = `MYREL_CONNECTOR_${i}_${j}`;
              secrets[`MYREL_CONNECTOR_${i}_${j}`] = value;
            });
            return { transport: "stdio", name: c.name, command: c.command!, args: c.args ?? [], env };
          }),
        );
        spec.mcp = { url: `${origin}${mcpPath}`, connectors: cloud };
        // The sandbox's disk does not outlive it; the thread's workspace keeps the work outside the
        // repositories between turns (the repositories' own work goes to GitHub, see saveRepos).
        const [github, files, workspace] = await Promise.all([
          projectGithubToken(this.env, projectId, spec.timeoutSec),
          this.attachmentLinks(origin, input.attachments),
          threadWorkspace(this.env, threadId, spec.timeoutSec + WATCHDOG_GRACE_SEC),
        ]);
        if (github) secrets.GITHUB_TOKEN = github;
        if (files.length) secrets.MYREL_FILES = JSON.stringify(files);
        const backend = sandboxBackend(this.env, threadId, input.requester ?? "");
        const unavailable = backend.unavailable(spec);
        if (unavailable) throw new Error(unavailable);
        if (workspace) {
          spec.workspace = { remote: workspace.remote };
          secrets.MYREL_WORKSPACE_TOKEN = workspace.token;
        }
        await this.launch(stored(spec), backend.id, () => backend.start(spec, secrets), language);
        if (harness.note) await this.taskEvents(taskId, [{ type: "log", stream: "system", text: harness.note }]);
        if (this.runningTask()?.id === taskId) {
          await markSandboxActive(this.env.DB, { taskId, projectId, startedAt: new Date() }).catch((err) => console.error("sandbox active", err));
        }
        if (!workspace && (this.env as Partial<Env>).WORKSPACES) {
          await this.taskEvents(taskId, [
            { type: "log", stream: "system", text: "This thread's workspace could not be opened, so this turn's work will not be saved for the next one." },
          ]);
        }
      }
      await this.schedule(spec.timeoutSec + WATCHDOG_GRACE_SEC, "taskWatchdog", { taskId });
      if (this.runningTask()?.backend === "sandbox") await this.schedule(SANDBOX_CHECK_SEC, "sandboxCheck", { taskId });
    } catch (err) {
      // Once recorded, launch() finished the run as failed and finishAgentTurn reported it.
      if (!this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${taskId}`[0]) {
        await this.revokeGithub(taskId);
        this.deleteMeta("agent_token");
        this.deleteMeta("agent_turn");
        this.deleteMeta("agent_connectors");
        this.clearAccess();
        this.deleteMeta("agent_skills");
        const message = err instanceof Error ? err.message : String(err);
        await project.sendMessage({
          threadId,
          authorKind: "system",
          authorId: SYSTEM_ID,
          body: `This thread's agent could not start: ${message}`,
        });
        await project.updateThread(threadId, { status: "failed" });
        await project.notifyThread(threadId, "failed", message);
        await project.setActivity(threadId, false);
      }
    }
  }

  /**
   * Download links for the files attached in the thread, for the sandbox to fetch before the agent
   * starts (see MYREL_FILES in runner-core's task script). Newest first, within a count and size budget.
   */
  private async attachmentLinks(origin: string, attachments: Attachment[]): Promise<{ path: string; url: string }[]> {
    const { projectId } = this.ids();
    const picked: Attachment[] = [];
    let bytes = 0;
    for (const a of [...attachments].reverse()) {
      if (picked.some((p) => p.path === a.path)) continue;
      if (picked.length >= PREFETCH_MAX_FILES || bytes + a.size > PREFETCH_MAX_BYTES) break;
      picked.push(a);
      bytes += a.size;
    }
    return Promise.all(
      picked.map(async (a) => ({ path: a.path, url: await signFileLink(this.env, origin, { projectId, path: a.path, mode: "get", by: THREAD_AGENT_ID }) })),
    );
  }

  /** The agent's run ended: deliver what it left unsaid, settle the thread's state, and take any wakes that waited. */
  private async finishAgentTurn(taskId: string) {
    const [row] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${taskId}`;
    if (!row) return;
    this.sql`UPDATE tasks SET reported = 1 WHERE id = ${taskId}`;
    await this.revokeGithub(taskId);
    const turn = JSON.parse(this.getMeta("agent_turn") ?? "null") as AgentTurn | null;
    this.deleteMeta("agent_token");
    this.deleteMeta("agent_turn");
    this.deleteMeta("agent_connectors");
    this.clearAccess();
    this.deleteMeta("agent_skills");
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    // Closed while it ran: the card already reads closed, and the cancelled run has nothing to tell anyone.
    if (this.getMeta("closed") === "1") return void (await project.setActivity(threadId, false));
    let pending = turn?.pending ?? [];
    const replied = turn?.replied ?? false;
    const interrupted = this.getMeta("interrupted_task") === taskId;
    this.deleteMeta("interrupted_task");
    if (interrupted) {
      // Stopped for a message that waits: one line, and that message's turn starts now.
      const tr = (this.getMeta("language") ?? row.language).startsWith("tr");
      await project.sendMessage({
        threadId,
        authorKind: "system",
        authorId: SYSTEM_ID,
        body: tr ? "Durduruldu; yeni mesajla devam ediyor." : "Stopped; continuing with the new message.",
        artifacts: pending,
        stats: this.runStats(row, turn?.mark).stats,
      });
      await project.setActivity(threadId, false);
      this.setMeta("dirty", "1");
      await this.queue("threadTurn", null);
      return;
    }
    const resuming = JSON.parse(this.getMeta("resume_pending") ?? "null") as { resumes: number; delaySec: number; where?: ResumeWhere } | null;
    // A turn that ended on its own ends the chain of automatic continues.
    if (!resuming) this.deleteMeta("auto_resume");
    let lastText: string | null = null;
    // The usage since its last message goes on the message that ends the turn, if there is one.
    const tail = this.runStats(row, turn?.mark).stats;
    let sentTail = false;
    if (!replied && row.status === "done" && row.summary) {
      // It answered in its final message instead of through reply: that answer is still the person's.
      lastText = row.summary;
      await project.sendMessage({ threadId, authorKind: "agent", authorId: THREAD_AGENT_ID, body: row.summary, artifacts: pending, stats: tail });
      pending = [];
      sentTail = true;
    } else if (resuming) {
      // Cut off by the runner going away: one line instead of a failure report; the turn continues.
      const tr = (this.getMeta("language") ?? row.language).startsWith("tr");
      await project.sendMessage({
        threadId,
        authorKind: "system",
        authorId: SYSTEM_ID,
        body: resumingMessage(tr, resuming.resumes, resuming.delaySec, resuming.where),
        artifacts: pending,
        stats: tail,
      });
      pending = [];
      sentTail = true;
      await project.updateThread(threadId, { status: "working" });
      await project.setActivity(threadId, false);
      // Someone wrote meanwhile: their turn continues the work now (it gets the same note).
      if (this.getMeta("dirty") === "1") await this.queue("threadTurn", null);
      return;
    } else if (row.status !== "done") {
      await project.sendMessage({
        threadId,
        authorKind: "agent",
        authorId: THREAD_AGENT_ID,
        body: taskReport(this.toTask(row).title, row, this.taskLog(taskId, 15)),
        artifacts: pending,
        stats: tail,
      });
      pending = [];
      sentTail = true;
    }
    if (pending.length) {
      await project.sendMessage({ threadId, authorKind: "agent", authorId: THREAD_AGENT_ID, body: "", artifacts: pending, stats: tail });
      sentTail = true;
    }
    // Otherwise what it used after its last reply (often the rest of that reply's own model call) joins that reply.
    const last = turn?.lastReplyStats;
    if (!sentTail && last && tail.inputTokens + tail.outputTokens > 0) {
      await project.setMessageStats(last.id, this.runStats(row, last.from).stats);
    }
    const resolved = turn?.resolved ?? false;
    // Read right before the update: a choice card the coordinator passed on meanwhile is the person's now.
    const asked = (turn?.asked ?? false) || (!!turn?.questioned && !!this.getMeta("pending_question"));
    const failed = row.status === "failed" && !replied;
    await project.updateThread(threadId, {
      // A question to the coordinator is answered by the coordinator, so the thread is not waiting on a
      // person, unless something it asked or showed people this turn is.
      status: resolved ? "done" : asked && !turn?.needs ? "working" : failed ? "failed" : "review_ready",
      resolved,
    });
    const kind = failed ? "failed" : resolved ? "done" : ((turn?.needs === "review" ? "ready" : turn?.needs) ?? ((replied || lastText) && !asked ? "ready" : null));
    if (kind) await project.notifyThread(threadId, kind, lastText ?? turn?.lastReply ?? row.summary ?? "");
    await project.setActivity(threadId, false);
    if (this.getMeta("dirty") === "1") await this.queue("threadTurn", null);
  }

  /**
   * One MCP message from the thread's agent (POST /api/agent-mcp/:threadId). Only the token of the
   * running turn is accepted. Callable over RPC.
   */
  async agentMcp(token: string, body: unknown): Promise<{ ok: false } | { ok: true; answer: object | null }> {
    const hash = this.getMeta("agent_token");
    if (!hash || !this.runningTask() || !sameHash(hash, await hashAgentToken(token))) return { ok: false };
    const answer = await handleMcp(await this.agentToolset(), { name: "myrel", version: "1" }, body);
    return { ok: true, answer };
  }

  /**
   * Who a model call from the running turn bills (/api/agent-mcp/:threadId/model/*): the project
   * whose key the call uses and the turn's task. Only the running turn's token opens it, and only for
   * a cloud turn: a turn on someone's computer runs their own CLI with their own login, and its token
   * (which that person can read) must not spend the project's or the server's key, unchecked by the
   * plan limits that only a cloud turn passes. Callable over RPC.
   */
  async modelCaller(token: string): Promise<{ projectId: string; taskId: string } | null> {
    const hash = this.getMeta("agent_token");
    const task = this.runningTask();
    if (!hash || !task || task.backend !== "sandbox" || !sameHash(hash, await hashAgentToken(token))) return null;
    return { projectId: this.ids().projectId, taskId: task.id };
  }

  /**
   * What one model call through Myrel cost, added to its turn's usage; null for a call that used
   * tokens but has no price, counted so plan limits charge each such call. Callable over RPC.
   */
  async modelCost(taskId: string, costUsd: number | null): Promise<void> {
    if (costUsd === null) {
      if (this.runningTask()?.id === taskId) this.setMeta(`unpriced_calls:${taskId}`, String(this.unpricedCalls(taskId) + 1));
      return;
    }
    await this.taskEvents(taskId, [{ type: "usage", inputTokens: 0, outputTokens: 0, costUsd }]);
  }

  /** Model calls of a cloud turn that could not be priced (see modelCost). */
  private unpricedCalls(taskId: string): number {
    return Number(this.getMeta(`unpriced_calls:${taskId}`) ?? 0);
  }

  /**
   * The connectors this turn's agent gets (see turnConnectors), remembered so the gateway knows
   * which remote ones the turn's token opens. None from a runner too old to pass them on.
   */
  private async turnConnectors(place: Exclude<TaskPlace, { kind: "error" }>, requester: string | null): Promise<TurnConnector[]> {
    const { projectId } = this.ids();
    if (place.kind === "local" && !(await runnerHasFeature(this.env, place.workspace.runnerId, "connectors"))) return [];
    const runnerId = place.kind === "local" ? place.workspace.runnerId : undefined;
    const connectors = await turnConnectors(this.env, { projectId, userId: requester, place: place.kind, runnerId }).catch((err) => {
      console.error("connectors", err);
      return [];
    });
    this.setMeta("agent_connectors", JSON.stringify(connectors.map((c) => ({ id: c.id, name: c.name, transport: c.transport }))));
    // Servers gain tools over time; keep the list settings show current without holding up the turn.
    const remote = connectors.filter((c) => c.transport === "http").map((c) => c.id);
    this.ctx.waitUntil(refreshStaleTools(this.env, remote).catch((err) => console.error("connector tools", err)));
    return connectors;
  }

  /**
   * The skills this turn's agent gets (see turnSkills), remembered so the running turn's token
   * opens their files. None from a runner too old to put them next to its CLI.
   */
  private async turnSkills(place: Exclude<TaskPlace, { kind: "error" }>, requester: string | null): Promise<TurnSkill[]> {
    const { projectId } = this.ids();
    if (place.kind === "local" && !(await runnerHasFeature(this.env, place.workspace.runnerId, "skills"))) return [];
    const skills = await turnSkills(this.env, { projectId, userId: requester }).catch((err) => {
      console.error("skills", err);
      return [];
    });
    // On someone's computer a project skill comes tamed (see tameSkillMd): its author may not be them.
    const tame = place.kind === "local";
    this.setMeta("agent_skills", JSON.stringify(skills.map((s) => ({ id: s.id, name: s.name, tame: tame && s.project }))));
    return skills;
  }

  /**
   * The files of the running turn's skills (GET /api/agent-mcp/:threadId/skills), for the sandbox
   * or the runner to put next to the agent. Only the running turn's token opens them. Callable over RPC.
   */
  async skillBundle(token: string): Promise<SkillBundle | null> {
    const hash = this.getMeta("agent_token");
    if (!hash || !this.runningTask() || !sameHash(hash, await hashAgentToken(token))) return null;
    const given = JSON.parse(this.getMeta("agent_skills") ?? "[]") as { id: string; name: string; tame?: boolean }[];
    const skills = await Promise.all(
      given.map(async (s) => {
        const files = await readBundle(this.env, s.id);
        if (!s.tame) return { name: s.name, files };
        return {
          name: s.name,
          files: files.map((f) =>
            f.path === "SKILL.md" ? { ...f, content: toBase64(new TextEncoder().encode(tameSkillMd(new TextDecoder().decode(fromBase64(f.content))))) } : f,
          ),
        };
      }),
    );
    return { skills: skills.filter((s) => s.files.length) };
  }

  /**
   * Where a remote connector's call from the running turn goes (GET/POST/DELETE
   * /api/agent-mcp/:threadId/c/:name), with its credentials. Only the running turn's token opens
   * it, and only for a connector that turn was given. Callable over RPC.
   */
  async connectorTarget(
    token: string,
    name: string,
  ): Promise<{ ok: true; url: string; headers: Record<string, string> } | { ok: false; error: "unauthorized" | "not_found" }> {
    const hash = this.getMeta("agent_token");
    if (!hash || !this.runningTask() || !sameHash(hash, await hashAgentToken(token))) return { ok: false, error: "unauthorized" };
    const given = JSON.parse(this.getMeta("agent_connectors") ?? "[]") as { id: string; name: string; transport: string }[];
    const connector = given.find((c) => c.name === name && c.transport === "http");
    const target = connector ? await remoteTarget(this.env, connector.id) : null;
    return target ? { ok: true, ...target } : { ok: false, error: "not_found" };
  }

  /**
   * The folders the running turn's CLI works in, as its runner reports them when the run starts
   * (feature "project-folders"). Callable over RPC by the RunnerAgent.
   */
  agentFolders(taskId: string, folders: string[]): void {
    if (this.runningTask()?.id === taskId) this.setMeta("access_folders", JSON.stringify(folders));
  }

  /**
   * Claude Code's permission prompt tool (`--permission-prompt-tool mcp__myrel__approve_access`).
   * A path inside the project's folders that still needs permission is about the runner's access
   * level, which Myrel does not widen. A path outside them is put to the person as a card, and the
   * run waits for the answer.
   */
  private approveAccessTool(): Tool {
    return tool({
      name: "approve_access",
      description:
        "Claude Code (and myrel-runner, for Codex's app server) calls this when a step needs permission; it asks the person when the step reaches outside the project's folders. Do not call it yourself.",
      input: z.object({ tool_name: z.string().max(200), input: z.record(z.string(), z.unknown()).default({}), tool_use_id: z.string().optional() }),
      run: async ({ tool_name, input }) => {
        const started = JSON.parse(this.getMeta("access_folders") ?? "[]") as string[];
        const targets = accessTargets(input, started[0]);
        const outside = targets.filter((t) => !insideAny(t.path, started));
        // A file inside the folders asks only when the runner is read-only, which stays as it is.
        if (!outside.length && targets.length) return denyAnswer(ACCESS_LEVEL_DENIED);
        // A command the runner's access level does not run on its own: the person decides here,
        // instead of restarting the runner with --access full.
        if (!outside.length) {
          // Pull requests go through Myrel's GitHub App, which credits the person and follows them.
          if (opensPullRequest(input)) return denyAnswer(USE_OPEN_PULL_REQUEST);
          if (this.getMeta("access_commands")) return allowAnswer(input);
          const command = describeCommand(tool_name, input);
          const answer = await this.askAccess(command, command, "command");
          if (answer === null) return denyAnswer("The person did not answer in time about running this. Carry on without it, and say in your reply what you could not do.");
          if (answer === "deny") return denyAnswer("The person did not allow running this. Carry on without it; if the work cannot be done without it, say so in a reply.");
          return allowAnswer(input);
        }
        // Folders the person allowed this turn, or added to the project since it started.
        const workspace = await this.runningWorkspace();
        const allowed = () => [
          ...(JSON.parse(this.getMeta("access_grants") ?? "[]") as string[]),
          ...(workspace ? [workspace.path, ...workspace.folders] : []),
        ];
        for (const target of outside) {
          if (insideAny(target.path, allowed())) continue;
          const answer = await this.askAccess(target.folder, describeRequest(tool_name, target));
          if (answer === null) return denyAnswer(`The person did not answer about ${target.folder} in time. Carry on without it, and say in your reply what you could not reach.`);
          if (answer === "deny") return denyAnswer(`The person did not allow ${target.folder}. Carry on without it; if the work cannot be done without it, say so in a reply.`);
        }
        return allowAnswer(input);
      },
    });
  }

  /**
   * Puts one folder to the person as a card (or joins a card already asking about it) and waits for
   * the answer: null when none came in time or the turn ended.
   */
  private async askAccess(folder: string, what: string, kind?: "command"): Promise<AccessAnswer | null> {
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const until = Date.now() + ACCESS_WAIT_MS;
    // One card at a time: a card's answer is only its label, so with two open it could not tell
    // which folder it was about. A second folder waits for the first card to be answered.
    while (Date.now() < until && this.runningTask() && this.accessRequests().some((r) => r.folder !== folder && !r.answer)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!this.runningTask() || Date.now() >= until) return null;
    let request = this.accessRequests().find((r) => r.folder === folder && r.kind === kind && !r.answer);
    if (!request) {
      request = { id: crypto.randomUUID(), folder, ...(kind && { kind }) };
      this.setMeta("access_requests", JSON.stringify([...this.accessRequests(), request]));
      const turn = JSON.parse(this.getMeta("agent_turn") ?? "null") as AgentTurn | null;
      const language = turn?.language ?? "en";
      const body = kind === "command" ? commandMessage(folder, language) : accessMessage(folder, what, language);
      const m = await project.sendMessage({ threadId, authorKind: "agent", authorId: THREAD_AGENT_ID, body });
      // Not news for the next turn, unless someone wrote in between.
      if (m.seq === Number(this.getMeta("last_seen_seq") ?? 0) + 1) this.setMeta("last_seen_seq", String(m.seq));
      const id = request.id;
      this.setMeta("access_requests", JSON.stringify(this.accessRequests().map((r) => (r.id === id ? { ...r, messageId: m.id } : r))));
      await project.updateThread(threadId, { status: "blocked" });
      await project.notifyThread(threadId, "decision", body.split("\n")[0]!);
    }
    const id = request.id;
    while (Date.now() < until && this.runningTask()) {
      const answer = this.accessRequests().find((r) => r.id === id)?.answer;
      if (answer) {
        await project.updateThread(threadId, { status: "working" });
        return answer;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return null;
  }

  /** A person answered the running turn's folder cards. Returns false when the message is not such an answer. */
  private async answerAccess(reason: Extract<ThreadWake, { kind: "message" }>): Promise<boolean> {
    // Only one card is open at a time (see askAccess); the answer is for that one alone.
    const open = this.accessRequests().filter((r) => !r.answer).slice(0, 1);
    const answer = open[0]?.kind === "command" ? commandAnswer(reason.body ?? "") : accessAnswer(reason.body ?? "");
    if (!answer || !open.length || !this.runningTask()) return false;
    const { projectId } = this.ids();
    // The folders are on someone's own computer: only they answer for it. Anyone else's
    // "yes" is an ordinary message.
    const workspace = await this.runningWorkspace();
    if (!workspace || !reason.authorId || !(await ownsComputer(this.env, workspace.runnerId, reason.authorId))) return false;
    const given = answer;
    const grants = JSON.parse(this.getMeta("access_grants") ?? "[]") as string[];
    for (const r of open) {
      if (r.kind === "command") {
        if (given === "always") this.setMeta("access_commands", "1");
        r.answer = given;
        continue;
      }
      let mine = given;
      if (mine === "always" && !(await this.addProjectFolder(projectId, r.folder))) mine = "once";
      if (mine !== "deny") grants.push(r.folder);
      r.answer = mine;
    }
    this.setMeta("access_grants", JSON.stringify(grants));
    this.setMeta("access_requests", JSON.stringify(this.accessRequests().map((r) => open.find((o) => o.id === r.id) ?? r)));
    // The answered card shrinks to one line; the explanation was for while it waited.
    const turn = JSON.parse(this.getMeta("agent_turn") ?? "null") as AgentTurn | null;
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    for (const r of open) {
      if (!r.messageId) continue;
      await project.editMessage(r.messageId, answeredAccessMessage(r, turn?.language ?? "en")).catch((err) => console.warn("access card not shortened", err));
    }
    // The answer was for this turn: it is not news for the next one.
    if (reason.seq === Number(this.getMeta("last_seen_seq") ?? 0) + 1) {
      this.setMeta("last_seen_seq", String(reason.seq));
      await project.updateThread(this.ids().threadId, { seenSeq: reason.seq });
    }
    return true;
  }

  private repoRequest(): RepoRequest | null {
    return JSON.parse(this.getMeta("repo_request") ?? "null") as RepoRequest | null;
  }

  /**
   * A person answered the repository card. "Connect" connects it as them (owner or admin, with
   * GitHub access to it): on success the turn their answer starts has it; otherwise a new card says
   * what to do first and no turn starts. Returns true when the answer needs no turn.
   */
  private async answerRepoRequest(reason: Extract<ThreadWake, { kind: "message" }>): Promise<boolean> {
    const request = this.repoRequest();
    const answer = request ? repoAnswer(reason.body ?? "") : null;
    if (!request || !answer) return false;
    if (answer === "skip" || !reason.authorId) {
      this.deleteMeta("repo_request");
      return false;
    }
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const language = this.getMeta("language") ?? "en";
    const result = await connectRepoByName(this.env, projectId, reason.authorId, request.repo);
    if (result.ok) {
      this.deleteMeta("repo_request");
      await project.sendMessage({ threadId, authorKind: "system", authorId: SYSTEM_ID, body: repoConnectedMessage(result.repo.fullName, language) });
      return false;
    }
    const origin = await project.publicOrigin();
    const back = `/projects/${projectId}/threads/${threadId}`;
    // Without a known address the links stay relative, which the web app still opens.
    const links = {
      connectUrl: `${origin ?? ""}/api/github/connect?returnTo=${encodeURIComponent(back)}`,
      settingsUrl: `${origin ?? ""}/settings/projects/${projectId}`,
    };
    const body = repoFailureMessage(request.repo, result.reason, links, language);
    if (result.reason === "not_configured") {
      this.deleteMeta("repo_request");
      await project.sendMessage({ threadId, authorKind: "system", authorId: SYSTEM_ID, body });
      return false;
    }
    // A fresh card to try again from once they did what it says; the agent has nothing to do yet.
    const m = await project.sendMessage({ threadId, authorKind: "agent", authorId: THREAD_AGENT_ID, body });
    this.setMeta("repo_request", JSON.stringify({ repo: request.repo, messageId: m.id } satisfies RepoRequest));
    // Neither the answer nor the new card is news for the next turn, unless someone wrote in between.
    const seen = Number(this.getMeta("last_seen_seq") ?? 0);
    if (reason.seq === seen + 1 && m.seq === reason.seq + 1) this.setMeta("last_seen_seq", String(m.seq));
    return true;
  }

  /**
   * A person answered the branch card of a pull request the agent closed. "Delete" deletes the
   * branch when they are the person the thread worked for, or a project owner or admin. Either way
   * the answer and the line saying what happened need no turn. Returns true when it was an answer.
   */
  private async answerBranchRequest(reason: Extract<ThreadWake, { kind: "message" }>): Promise<boolean> {
    const request = JSON.parse(this.getMeta("branch_request") ?? "null") as BranchRequest | null;
    const answer = request ? branchAnswer(reason.body ?? "") : null;
    if (!request || !answer) return false;
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const language = this.getMeta("language") ?? "en";
    let body: string | null = null;
    if (answer === "delete") {
      const role = reason.authorId
        ? (
            await createDb(this.env.DB)
              .select({ role: schema.projectMembers.role })
              .from(schema.projectMembers)
              .where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.userId, reason.authorId)))
              .limit(1)
          )[0]?.role
        : undefined;
      const allowed = !!reason.authorId && (reason.authorId === request.requester || role === "owner" || role === "admin");
      if (!allowed) {
        // The card stays for someone who may answer it.
        body = branchResultMessage({ branch: request.branch, forbidden: true }, language);
      } else {
        this.deleteMeta("branch_request");
        try {
          body = branchResultMessage(await deletePullBranch(this.env, projectId, request), language);
        } catch (err) {
          console.warn("deleting the branch failed", request, err);
          body = language === "tr" ? `\`${request.branch}\` dalı silinemedi: GitHub isteği reddetti.` : `\`${request.branch}\` could not be deleted: GitHub refused.`;
        }
      }
    } else {
      this.deleteMeta("branch_request");
    }
    const line = body ? await project.sendMessage({ threadId, authorKind: "system", authorId: SYSTEM_ID, body }) : null;
    const seen = line?.seq ?? reason.seq;
    // Neither the answer nor the line after it is news for the next turn, unless someone wrote in between.
    if (reason.seq !== undefined && seen !== undefined && reason.seq === Number(this.getMeta("last_seen_seq") ?? 0) + 1 && seen <= reason.seq + 1) {
      this.setMeta("last_seen_seq", String(seen));
      await project.updateThread(threadId, { seenSeq: seen });
    }
    return true;
  }

  /** Shares the folder on the computer the run is on and adds it to the project's folders there. */
  private async addProjectFolder(projectId: string, folder: string): Promise<boolean> {
    const workspace = await this.runningWorkspace();
    if (!workspace) return false;
    const runner = await getAgentByName(this.env.RUNNER_AGENT, workspace.runnerId);
    const shared = await runner.setShared(folder, true);
    if (!shared.ok) {
      console.warn("folder not shared", folder, shared.reason);
      return false;
    }
    // The runner keeps the folder's real path; that is the one it accepts later.
    const path = shared.folders.find((f) => f.path === folder)?.path ?? shared.folders.at(-1)?.path ?? folder;
    return setWorkspaceFolder(this.env, projectId, path, true, workspace.runnerId);
  }

  private accessRequests(): AccessRequest[] {
    return JSON.parse(this.getMeta("access_requests") ?? "[]") as AccessRequest[];
  }

  private clearAccess() {
    this.deleteMeta("access_folders");
    this.deleteMeta("access_grants");
    this.deleteMeta("access_requests");
    this.deleteMeta("access_commands");
  }

  // ---- Connector suggestions -------------------------------------------------

  /** The connector cards this thread's agent posted, newest last. */
  private suggestions(): StoredSuggestion[] {
    return JSON.parse(this.getMeta("connector_suggestions") ?? "[]") as StoredSuggestion[];
  }

  /** Posts a connector card for the person; false while another one waits for an answer. */
  private async postSuggestion(reason: string, offers: ConnectorOffer[]): Promise<boolean> {
    const all = this.suggestions();
    if (all.some((s) => s.state === "open")) return false;
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const suggestion: ConnectorSuggestion = { id: createId("suggestion"), reason, offers, state: "open" };
    const m = await project.sendMessage({ threadId, authorKind: "agent", authorId: THREAD_AGENT_ID, body: formatConnectorSuggestion(suggestion) });
    // Not news for the next turn, unless someone wrote in between.
    if (m.seq === Number(this.getMeta("last_seen_seq") ?? 0) + 1) this.setMeta("last_seen_seq", String(m.seq));
    // Older answered cards are kept only as far as the card's message needs them.
    this.setMeta("connector_suggestions", JSON.stringify([...all.slice(-19), { ...suggestion, messageId: m.id }]));
    return true;
  }

  /** One offer of a card still waiting for an answer, for the person to connect. Callable over RPC. */
  openOffer(suggestionId: string, offerId: string): ConnectorOffer | null {
    const s = this.suggestions().find((x) => x.id === suggestionId);
    return s?.state === "open" ? (s.offers.find((o) => o.id === offerId) ?? null) : null;
  }

  /**
   * A card's offer was connected (at once, or after signing in): the card says so, and a line from
   * the person wakes the agent, whose next turn has the connector. Callable over RPC.
   */
  async suggestionConnected(suggestionId: string, offerId: string, userId: string): Promise<void> {
    const s = this.suggestions().find((x) => x.id === suggestionId);
    const offer = s?.offers.find((o) => o.id === offerId);
    if (!s || !offer || s.state !== "open") return;
    await this.settleSuggestion(s, { state: "connected", connected: offerId });
    const tr = this.getMeta("language") === "tr";
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    await project.sendAsUser(threadId, userId, tr ? `${offer.name} bağlandı, devam edebilirsin.` : `I connected ${offer.name}. Carry on.`);
  }

  /** Not now: the card closes, its offers are not made again in this thread, and the agent carries on without them. Callable over RPC. */
  async dismissSuggestion(suggestionId: string, userId: string): Promise<boolean> {
    const s = this.suggestions().find((x) => x.id === suggestionId);
    if (!s || s.state !== "open") return false;
    await this.settleSuggestion(s, { state: "dismissed" });
    const declined = new Set(JSON.parse(this.getMeta("declined_connectors") ?? "[]") as string[]);
    for (const o of s.offers) {
      declined.add(o.id);
      declined.add(o.url);
    }
    this.setMeta("declined_connectors", JSON.stringify([...declined].slice(-100)));
    const tr = this.getMeta("language") === "tr";
    const names = s.offers.map((o) => o.name).join(", ");
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    await project.sendAsUser(threadId, userId, tr ? `${names} şimdilik bağlamıyorum, onsuz devam et.` : `Not connecting ${names} for now. Carry on without it.`);
    return true;
  }

  private async settleSuggestion(s: StoredSuggestion, patch: Pick<ConnectorSuggestion, "state" | "connected">) {
    const next = { ...s, ...patch };
    this.setMeta("connector_suggestions", JSON.stringify(this.suggestions().map((x) => (x.id === s.id ? next : x))));
    const { projectId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const { messageId: _, ...card } = next;
    await project.editMessage(s.messageId, formatConnectorSuggestion(card));
  }

  /** Who this thread's pull requests credit: the person it works for, and a link back to the thread. */
  private async pullCredit(): Promise<PullCredit> {
    const { projectId, threadId } = this.ids();
    const requester = this.getMeta("requester") || null;
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const [origin, person, login] = await Promise.all([
      project.publicOrigin(),
      requester
        ? createDb(this.env.DB).select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, requester)).then((r) => r[0])
        : undefined,
      requester ? githubLogin(this.env.DB, requester) : null,
    ]);
    return { name: person?.name ?? null, login, threadUrl: origin ? `${origin}/projects/${projectId}/threads/${threadId}` : null };
  }

  /** Myrel's thread tools for the agent, acting on this thread and recording what the turn did. */
  private async agentToolset(): Promise<Tool[]> {
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const turn = () => JSON.parse(this.getMeta("agent_turn") ?? "null") as AgentTurn;
    const save = (patch: Partial<AgentTurn>) => this.setMeta("agent_turn", JSON.stringify({ ...turn(), ...patch }));
    // A pull request a reply only mentions is credited only when it was opened during this turn,
    // which makes it this agent's (opened with gh, say); an older one may not be this thread's.
    const track = (url: string, credit?: PullCredit) => trackPullRequest(this.env, projectId, threadId, url, credit);
    const local = this.runningTask()?.backend === "local";
    const reply = async (text: string, needs?: ReplyNeeds, files?: string[]): Promise<Message> => {
      // Checked before anything is sent, so a wrong path fails the call and the agent can fix it.
      const attachments = files?.length ? await project.attachmentsFor(files) : [];
      const t = turn();
      const row = this.runningTask();
      const counted = row ? this.runStats(row, t.mark) : null;
      save({ pending: [], replied: true, lastReply: text, needs: louder(needs, t.needs), ...(counted && { mark: counted.mark }) });
      const m = await project.sendMessage({
        threadId,
        authorKind: "agent",
        authorId: THREAD_AGENT_ID,
        body: text,
        attachments,
        artifacts: t.pending,
        ...(counted && { stats: counted.stats }),
      });
      if (counted) save({ lastReplyStats: { id: m.id, from: counted.from } });
      if (t.planDone && row?.backend === "sandbox") {
        const at = Date.now();
        save({ doneReplyAt: at });
        await this.schedule(FINISH_AFTER_REPLY_SEC, "finishAfterReply", { taskId: row.id, at });
      }
      // Its own reply is not news next turn, unless someone wrote in between (then that stays NEW).
      if (m.seq === Number(this.getMeta("last_seen_seq") ?? 0) + 1) this.setMeta("last_seen_seq", String(m.seq));
      // A pull request it links to is followed even when it forgot track_pull_request.
      const urls = pullRequestUrls(text);
      const started = this.runningTask()?.created_at;
      const credit = urls.length && started ? { ...(await this.pullCredit()), since: new Date(Date.parse(started) - 60_000).toISOString() } : undefined;
      for (const url of urls) await track(url, credit).catch((err) => console.warn("tracking pull request failed", url, err));
      return m;
    };
    const tools: Tool[] = [
      ...threadTools({
        reply,
        askDecision: async ({ decision, context, askPerson }) => {
          const card = decisionCard(decision, context);
          // One card waits on the coordinator at a time; another one goes straight to the person.
          if (askPerson || this.getMeta("pending_question")) {
            await reply(card, "decision");
            return "person";
          }
          const id = createId("question");
          this.setMeta("pending_question", JSON.stringify({ id, card, question: decision.question } satisfies PendingQuestion));
          save({ questioned: true });
          // Whatever happens to the coordinator's turn, the card reaches the person in the end.
          await this.schedule(QUESTION_TIMEOUT_SEC, "questionTimeout", { id });
          try {
            await project.askCoordinator(threadId, { questionId: id, question: renderQuestion(decision, context) });
          } catch (err) {
            console.warn("asking the coordinator failed; asking the person", err);
            await this.escalateQuestion(id);
          }
          return "coordinator";
        },
        publishArtifact: async (input) => {
          const result = await project.publishArtifact({ ...input, threadId });
          if ("error" in result) throw new Error(result.error);
          const { artifact } = result;
          const ref = { artifactId: artifact.id, version: artifact.version, title: artifact.title };
          save({ pending: [...turn().pending.filter((p) => p.artifactId !== artifact.id), ref], published: true });
          return artifact;
        },
        setPlan: async (plan) => {
          this.setMeta("plan", JSON.stringify(plan));
          this.deleteMeta("plan_finished");
          // A plan with work left (again) keeps the turn going after a reply.
          save({ planDone: plan.steps.every((s) => s.state !== "todo" && s.state !== "active"), doneReplyAt: undefined });
          await this.showStatus();
        },
        planned: () => turn().planDone !== undefined,
        requestCoordinator: async (kind, reason) => {
          save({ asked: true });
          await project.requestCoordinator(threadId, kind, reason, this.getMeta("requester") || null);
          // People see what the thread waits on, instead of a thread that went quiet.
          const body = `${turn()?.language === "tr" ? "Koordinatörün yanıtı bekleniyor" : "Waiting for the coordinator"}: ${reason.length > 300 ? `${reason.slice(0, 300)}…` : reason}`;
          const m = await project.sendMessage({ threadId, authorKind: "system", authorId: SYSTEM_ID, body });
          if (m.seq === Number(this.getMeta("last_seen_seq") ?? 0) + 1) this.setMeta("last_seen_seq", String(m.seq));
        },
        // What it showed or asked this turn waits on the person: the thread stays "waiting for you",
        // and their answer wakes it, instead of reading as finished.
        resolve: async () => {
          const t = turn();
          if (t.needs || t.published || t.questioned) {
            return "Not resolved: this turn asked the person something or presented work for their feedback, so the thread waits on their answer. End your turn without resolving; it shows as waiting for them.";
          }
          save({ resolved: true });
          return null;
        },
        listRepoFiles: (repo, path, ref) => listRepoFiles(this.env, projectId, repo, path, ref),
        readRepoFile: (repo, path, ref) => readRepoFile(this.env, projectId, repo, path, ref),
        trackPullRequest: async (url) => {
          const pr = await track(url, await this.pullCredit());
          if (!pr) throw new Error("That is not a pull request on a repository connected to this project.");
          return `Following ${pr.repo}#${pr.number}: its state shows in the thread, and CI failures, reviews and the merge will wake you.`;
        },
        requestRepo: async (repo, reason) => {
          if ((await listProjectRepos(this.env.DB, projectId)).some((r) => r.fullName.toLowerCase() === repo.toLowerCase())) {
            return `${repo} is already connected to this project.`;
          }
          const open = this.repoRequest();
          if (open) return `A card asking for ${open.repo} is already waiting for the person. End your turn.`;
          const m = await project.sendMessage({
            threadId,
            authorKind: "agent",
            authorId: THREAD_AGENT_ID,
            body: repoRequestMessage(repo, reason, turn()?.language ?? "en"),
          });
          if (m.seq === Number(this.getMeta("last_seen_seq") ?? 0) + 1) this.setMeta("last_seen_seq", String(m.seq));
          this.setMeta("repo_request", JSON.stringify({ repo, messageId: m.id } satisfies RepoRequest));
          await project.updateThread(threadId, { status: "blocked" });
          return `The card is in the thread. End your turn now: once ${repo} is connected you are woken with it connected, and carry on from there.`;
        },
        openPullRequest: async (input) => {
          const { pr, created } = await openPullRequest(this.env, projectId, threadId, input, await this.pullCredit());
          return `${created ? "Opened" : "An open pull request already exists for that branch:"} ${pr.url} (${pr.repo}#${pr.number}). Myrel follows it: CI failures, reviews and the merge will wake you.`;
        },
        closePullRequest: async ({ url, reason, deleteBranch }) => {
          const { pr, already, branch } = await closePullRequest(this.env, projectId, threadId, url, reason);
          const done = `${pr.repo}#${pr.number} ${already ? "was already closed" : "is closed without merging; your reason is on it as a comment"}.`;
          if (!deleteBranch) return `${done} Its branch ${branch.branch} stays, so it can be reopened.`;
          if (branch.blocked) return `${done} Its branch ${branch.branch} cannot be deleted: ${branchBlockText(branch.blocked, "en")}.`;
          const m = await reply(branchRequestMessage(branch, reason, turn()?.language ?? "en"), "decision");
          const request: BranchRequest = { ...branch, requester: this.getMeta("requester") || null, messageId: m.id };
          this.setMeta("branch_request", JSON.stringify(request));
          return `${done} A card asks the person whether to delete its branch ${branch.branch}; Myrel deletes it if they say so, without you. Do not ask again.`;
        },
      }),
      ...suggestionTools({
        search: (q) => searchOffers(this.env, q),
        find: (ids) => findOffers(this.env, ids),
        known: () => knownConnectors(this.env, projectId, this.getMeta("requester") || null),
        declined: () => new Set(JSON.parse(this.getMeta("declined_connectors") ?? "[]") as string[]),
        post: (reason, offers) => this.postSuggestion(reason, offers),
      }),
      ...knowledgeTools({
        memoryRead: (name: string) => project.getMemory(name),
        memoryWrite: (name: string, description: string, content: string) => project.putMemory(name, { description, content }, BY),
        memoryMark: (name: string, input: MarkMemoryInput) => project.markMemory(name, input),
        memoryDelete: (name: string) => project.deleteMemory(name),
        memoryNames: async () => (await project.listMemory()).map((m) => m.name),
        listFiles: (prefix?: string) => project.listFiles(prefix),
        readText: (path: string) => project.readFileText(path),
        writeText: (path: string, content: string) => project.writeFileText(path, content, BY),
        // The harness has a shell: binary files move with curl over a signed link.
        fileLink: async (path: string, mode: "get" | "put") => {
          const origin = await project.publicOrigin();
          return origin ? signFileLink(this.env, origin, { projectId, path, mode, by: THREAD_AGENT_ID }) : null;
        },
      }),
      ...routineTools({
        listRoutines: () => project.listRoutines(),
        // A routine the agent sets up works for the person this turn works for.
        createRoutine: (input: Parameters<typeof project.createRoutine>[0]) => project.createRoutine(input, this.getMeta("requester") || "agent"),
        // A prompt or target the agent rewrites works for the person this turn works for, like a new routine.
        updateRoutine: (id: string, patch: Parameters<typeof project.updateRoutine>[1]) =>
          project.updateRoutine(id, patch, this.getMeta("requester") || "agent"),
        setPaused: (id: string, paused: boolean) => project.updateRoutine(id, { paused }),
        deleteRoutine: (id: string) => project.deleteRoutine(id),
        defaultTimezone: turn()?.timezone ?? "UTC",
        threadId,
      }),
    ];
    // What people wrote since the turn started reaches it with its next call to Myrel, without stopping it.
    // The folder-approval tool is left out: the CLI reads its answer as JSON.
    const delivering = tools.map(
      (t): Tool => ({
        ...t,
        run: async (input) => {
          const out = await t.run(input);
          const news = await this.takeNews().catch((err) => (console.warn("delivering new messages failed", err), null));
          if (!news) return out;
          const outcome = typeof out === "string" ? { output: out } : out;
          return { ...outcome, output: `${outcome.output}\n\n${news}` };
        },
      }),
    );
    return [...(local ? [this.approveAccessTool()] : []), ...delivering];
  }

  /**
   * People's messages the running turn has not seen, as a note to add to a tool's result, and from
   * then on seen. Only the messages of the person the turn works for: anyone else's ask may need
   * another person's computer or connectors, so it waits for a turn of its own (or Interrupt).
   */
  private async takeNews(): Promise<string | null> {
    const requester = this.getMeta("requester");
    if (!requester || !this.runningTask()) return null;
    const seen = Number(this.getMeta("last_seen_seq") ?? 0);
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const { messages, names } = await project.threadMessagesAfter(threadId, seen);
    const other = messages.findIndex((m) => m.authorKind === "user" && m.authorId !== requester);
    const taken = other === -1 ? messages : messages.slice(0, other);
    const news = taken.filter((m) => m.authorKind === "user");
    if (!news.length) return null;
    const last = taken.at(-1)!.seq;
    // Read again: another call may have taken them meanwhile.
    if (Number(this.getMeta("last_seen_seq") ?? 0) !== seen) return null;
    this.setMeta("last_seen_seq", String(last));
    // Taken in whole, with nothing else waiting: no turn after this one just for them.
    if (other === -1 && !this.getMeta("wake_other") && Number(this.getMeta("wake_seq") ?? 0) <= last) this.setMeta("dirty", "0");
    await project.updateThread(threadId, { seenSeq: last });
    return newsNote(news, names);
  }

  /**
   * The line under an agent message: what the turn's run used since `from` (the turn's start, or the
   * previous message's line), where it ran, the harness and its model. Returns the new mark too.
   */
  private runStats(row: TaskRow, from?: StatsMark): { stats: MessageStats; from: StatsMark; mark: StatsMark } {
    const spec = JSON.parse(row.spec) as StoredSpec;
    const progress = JSON.parse(row.progress) as TaskProgress;
    const start = from ?? { at: Date.parse(row.created_at), inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const mark: StatsMark = { at: Date.now(), ...progress.usage };
    const inputTokens = Math.max(0, mark.inputTokens - start.inputTokens);
    const outputTokens = Math.max(0, mark.outputTokens - start.outputTokens);
    const costUsd = Math.max(0, mark.costUsd - start.costUsd);
    const runtime = taskRuntime(row.backend);
    const model = spec.model?.id ?? progress.model ?? "";
    const stats: MessageStats = {
      model,
      durationMs: Math.max(0, mark.at - start.at),
      calls: 0,
      inputTokens,
      cachedInputTokens: 0,
      outputTokens,
      // A person's own CLI runs on their own account, so Myrel puts no price on it.
      costMicros: runtime === "local" ? null : taskCostMicros(this.env, model || null, { inputTokens, outputTokens, costUsd }),
      runtime,
      ...(runtime === "local" && spec.computer && { computer: spec.computer }),
      harness: spec.harness,
    };
    return { stats, from: start, mark };
  }

  /**
   * What a person's CLI reported using so far in a run, summed from its start (myrel-runner sends
   * totals). Added to the run's progress as the difference. Callable over RPC.
   */
  async cliUsage(taskId: string, usage: CliUsage): Promise<void> {
    const [row] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${taskId}`;
    if (!row || row.status !== "running") return;
    const progress = JSON.parse(row.progress) as TaskProgress;
    const inputTokens = Math.max(0, usage.inputTokens - progress.usage.inputTokens);
    const outputTokens = Math.max(0, usage.outputTokens - progress.usage.outputTokens);
    const newModel = usage.model && usage.model !== progress.model ? usage.model : undefined;
    if (inputTokens === 0 && outputTokens === 0 && !newModel) return;
    await this.taskEvents(taskId, [{ type: "usage", inputTokens, outputTokens, ...(newModel && { model: newModel }) }]);
  }

  // ---- Runs -----------------------------------------------------------------
  /** Records a task, starts it on its backend and shows it. */
  private async launch(spec: StoredSpec, backend: string, start: () => Promise<void>, language?: string) {
    // Recorded before starting: a fast task can report back before start() returns.
    this.sql`INSERT INTO tasks (id, spec, backend, status, progress, language, created_at)
      VALUES (${spec.taskId}, ${JSON.stringify(spec)}, ${backend}, ${"running"}, ${JSON.stringify(emptyProgress())},
        ${language || "en"}, ${new Date().toISOString()})`;
    await this.publishTask(spec.taskId);
    try {
      await start();
    } catch (err) {
      await this.taskEvents(spec.taskId, [
        { type: "done", ok: false, error: `Could not start: ${err instanceof Error ? err.message : String(err)}` },
      ]);
      throw err;
    }
  }

  /**
   * Progress from a runner (the sandbox, or a person's myrel-runner). Callable
   * over RPC. Events after the task finished are ignored.
   */
  async taskEvents(taskId: string, events: RunnerEvent[]): Promise<void> {
    const [row] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${taskId}`;
    if (!row || row.status !== "running") return;
    const spec = JSON.parse(row.spec) as StoredSpec;

    const lines: TerminalLine[] = [];
    let progress = JSON.parse(row.progress) as TaskProgress;
    // Runners send events in batches, so a line's time is when its batch arrived (within a second).
    const at = Date.now();
    const ms = (v: number | undefined) => (v === undefined ? {} : { ms: Math.round(v) });
    for (const e of events) {
      progress = reduceTask(progress, e);
      if (e.type === "log") lines.push({ stream: e.stream, text: e.text, at, ...ms(e.ms) });
      else if (e.type === "tool") lines.push({ stream: "system", text: `→ ${e.title}`, at, tool: true, ...ms(e.ms) });
      else if (e.type === "phase" && e.state === "failed") lines.push({ stream: "stderr", text: e.detail ?? `${e.phase} failed`, at });
      else if (e.type === "pr") lines.push({ stream: "system", text: `Pull request: ${e.url}`, at });
    }
    for (const l of lines) {
      this.sql`INSERT INTO task_log (task_id, stream, text, at, ms, tool)
        VALUES (${taskId}, ${l.stream}, ${l.text}, ${l.at ?? null}, ${l.ms ?? null}, ${l.tool ? 1 : null})`;
    }
    if (lines.length) {
      this.sql`DELETE FROM task_log WHERE task_id = ${taskId} AND id <= (
        SELECT id FROM task_log WHERE task_id = ${taskId} ORDER BY id DESC LIMIT 1 OFFSET ${MAX_LOG_LINES})`;
    }

    const finished = progress.finished;
    const status: TaskStatus = !finished
      ? "running"
      : finished.ok
        ? "done"
        : finished.error === "Cancelled."
          ? "cancelled"
          : "failed";
    const summary = finished
      ? finished.ok
        ? progress.lastText
        : [finished.error, progress.lastText].filter(Boolean).join("\n\n") || null
      : null;
    this.sql`UPDATE tasks SET progress = ${JSON.stringify(progress)}, status = ${status}, summary = ${summary},
      pr_url = ${progress.prUrl}, finished_at = ${finished ? new Date().toISOString() : null} WHERE id = ${taskId}`;

    const projectId = this.getMeta("project_id");
    const threadId = this.getMeta("thread_id");
    if (!projectId || !threadId) return;
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    if (lines.length) await project.broadcastTask({ type: "task.output", taskId, threadId, lines });
    // An older loop's task nested its steps under the plan; an agent turn's plan is the agent's own,
    // and its latest step shows as the thread's activity (the runner sets it for the person's computer).
    if (!spec.agent) {
      this.setMeta("task_checklist", renderChecklist(spec.title, progress, row.language));
      await this.showStatus();
    } else if (!finished && row.backend !== "local") {
      const step = events.findLast((e) => e.type === "tool");
      if (step?.type === "tool") await project.setActivity(threadId, true, step.title.slice(0, 200));
    }
    if (finished) {
      if (spec.model) {
        const ctx = { projectId, threadId, taskId, provider: spec.model.provider, model: spec.model.id };
        const ms = Date.now() - Date.parse(row.created_at);
        await recordTaskUsage(this.env, ctx, progress.usage, ms, this.unpricedCalls(taskId)).catch((err) => console.error("task usage", err));
        this.deleteMeta(`unpriced_calls:${taskId}`);
      }
      if (row.backend === "sandbox") {
        const run = { taskId, projectId, threadId, startedAt: new Date(row.created_at), endedAt: new Date() };
        await recordSandboxRun(this.env.DB, run).catch((err) => console.error("sandbox run", err));
      }
      await this.publishTask(taskId);
      // From now on the webhook keeps the pull request's state current and wakes this thread on CI and reviews.
      if (progress.prUrl) {
        await trackPullRequest(this.env, projectId, threadId, progress.prUrl, await this.pullCredit()).catch((err) =>
          console.error("tracking pull request failed", progress.prUrl, err),
        );
      }
      // A turn's run was the agent itself; an older loop's task result wakes the thread.
      if (spec.agent) await this.finishAgentTurn(taskId);
      else await this.markDirty();
    }
  }

  /** Stops the running turn, if any. */
  private async cancelRunningTask(): Promise<void> {
    const row = this.runningTask();
    if (row) await this.backendOf(row).cancel(row.id).catch((err) => console.warn("cancel failed", err));
  }

  /** Every task in this thread with its recent terminal output. Callable over RPC. */
  getTasks(): TaskWithLog[] {
    return this.taskRows().map((row) => ({ ...this.toTask(row), log: this.taskLog(row.id, 500) }));
  }

  /** Cancels a task on a person's request. Callable over RPC. */
  async cancelTask(taskId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const row = this.runningTask();
    if (!row || row.id !== taskId) return { ok: false, error: "This task is not running." };
    try {
      if (row.backend === "sandbox") {
        // A sandbox that lost the task (restarted by a deploy) cannot stop it, so it ends here.
        const stopped = await this.env.SANDBOX.getByName(this.getMeta("thread_id")!).cancel(taskId);
        if (!stopped) await this.taskEvents(taskId, [{ type: "done", ok: false, error: "Cancelled." }]);
        return { ok: true };
      }
      await this.backendOf(row).cancel(taskId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * A person asked to stop the running turn so the messages waiting for it go now ("Interrupt and
   * send"). The turn ends with one line instead of a failure report, and the next turn starts at once
   * with what is waiting; a local CLI continues the same session. A cloud turn's harness is ended so
   * its task still saves the work. Nothing running: the waiting messages get their turn. Callable over RPC.
   */
  async interrupt(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.getMeta("closed") === "1") return { ok: false, error: "This thread is closed." };
    const row = this.runningTask();
    this.setMeta("dirty", "1");
    if (!row) {
      await this.queue("threadTurn", null);
      return { ok: true };
    }
    this.setMeta("interrupted_task", row.id);
    if (row.backend === "sandbox") {
      const ended = await this.env.SANDBOX.getByName(this.getMeta("thread_id")!)
        .finish(row.id)
        .catch((err) => (console.warn("ending an interrupted turn failed", err), false));
      if (ended) return { ok: true };
    }
    const cancelled = await this.cancelTask(row.id);
    if (!cancelled.ok) this.deleteMeta("interrupted_task");
    return cancelled;
  }

  /**
   * For project deletion: stops a running task and erases this thread's storage and schedules.
   * Returns whether the thread ever used a cloud sandbox, which then needs wiping too.
   */
  async wipe(): Promise<{ usedSandbox: boolean }> {
    const usedSandbox = this.sql<{ n: number }>`SELECT count(*) AS n FROM tasks WHERE backend = 'sandbox'`[0]!.n > 0;
    if (this.runningTask()) await this.cancelRunningTask();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { usedSandbox };
  }

  /** Schedule callback: a task its runner never finished (the container went away). */
  /**
   * A minute after the agent replied with its plan done: if its run is still going and it has not
   * replied or changed its plan since, the turn is over, so its harness is ended (as finished).
   */
  async finishAfterReply(payload: { taskId: string; at: number }): Promise<void> {
    const row = this.runningTask();
    if (!row || row.id !== payload.taskId || row.backend !== "sandbox") return;
    const turn = JSON.parse(this.getMeta("agent_turn") ?? "null") as AgentTurn | null;
    if (!turn?.planDone || turn.doneReplyAt !== payload.at) return;
    const ended = await this.env.SANDBOX.getByName(this.getMeta("thread_id")!)
      .finish(row.id)
      .catch((err) => (console.warn("ending a finished turn failed", err), false));
    if (!ended) console.warn("ending a finished turn: its harness was not running", row.id);
  }

  /** While a cloud turn runs: ends it when its sandbox no longer has it, else checks again later. */
  async sandboxCheck(payload: { taskId: string }): Promise<void> {
    const row = this.runningTask();
    if (!row || row.id !== payload.taskId || row.backend !== "sandbox") return;
    const sandbox = this.env.SANDBOX.getByName(this.getMeta("thread_id")!);
    if (await sandbox.running(row.id)) {
      // The plan's limits are checked as the turn goes, counting what it used so far, so one long turn
      // (or several at once) cannot run far past them; an over-limit turn ends with the reason.
      const over = await this.overLimit(row);
      if (over) {
        await this.taskEvents(row.id, [{ type: "done", ok: false, error: over }]);
        await sandbox.cancel(row.id).catch(() => false);
        return;
      }
      await this.schedule(SANDBOX_CHECK_SEC, "sandboxCheck", payload);
      return;
    }
    // The run is gone (the container stopped too): stops whatever it left there, and continues the
    // turn on its own like one a runner restart cut off.
    await sandbox.cancel(row.id).catch(() => false);
    await this.interrupted(row, { where: "sandbox", reason: SANDBOX_LOST, flapping: false });
  }

  /** GitHub is still working out whether one of the thread's pull requests merges cleanly: asks again shortly. */
  async scheduleConflictCheck(payload: ConflictCheck): Promise<void> {
    await this.schedule(CONFLICT_RETRY_SEC, "conflictCheck", payload);
  }

  async conflictCheck(payload: ConflictCheck): Promise<void> {
    await checkConflict(this.env, payload.repoId, payload.number, payload.attempt);
  }

  /**
   * The runner lost this task: it restarted (an update) or the computer disconnected, and its CLI
   * stopped with it. An agent turn continues on its own, within the limits in auto-resume.ts;
   * anything else fails as before. Callable over RPC by the runner's RunnerAgent.
   */
  async taskInterrupted(taskId: string, input: { restarted: boolean; flapping: boolean }): Promise<void> {
    const [row] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${taskId}`;
    if (!row || row.status !== "running") return;
    await this.interrupted(row, { where: "runner", reason: interruptedReason(input.restarted), flapping: input.flapping });
  }

  /**
   * Ends a run its runner or sandbox lost, and continues an agent turn on its own (auto-resume.ts).
   */
  private async interrupted(row: TaskRow, input: { where: ResumeWhere; reason: string; flapping: boolean }): Promise<void> {
    const taskId = row.id;
    const spec = JSON.parse(row.spec) as StoredSpec;
    const [last] = this.sql<{ text: string }>`SELECT text FROM task_log WHERE task_id = ${taskId} AND tool = 1 ORDER BY id DESC LIMIT 1`;
    const decision = decideResume({
      state: JSON.parse(this.getMeta("auto_resume") ?? "null") as ResumeState | null,
      // A run cut off before its first step may be what brings the runner down: it counts twice.
      progressed: !!last,
      flapping: input.flapping,
      // A turn that already resolved the thread has nothing left to continue.
      agent: !!spec.agent && !(JSON.parse(this.getMeta("agent_turn") ?? "null") as AgentTurn | null)?.resolved,
    });
    if (decision.resume) {
      this.setMeta("auto_resume", JSON.stringify(decision.state));
      const lastStep = last ? last.text.replace(/^→ /, "").split("\n")[0]!.slice(0, 300) : null;
      this.setMeta("resume_pending", JSON.stringify({ resumes: decision.state.resumes, delaySec: decision.delaySec, lastStep, where: input.where }));
      await this.schedule(decision.delaySec, "resumeInterrupted", { taskId });
    } else {
      this.deleteMeta("auto_resume");
    }
    const reason = input.reason;
    await this.taskEvents(taskId, [
      { type: "phase", phase: "agent", state: "failed", detail: reason },
      { type: "done", ok: false, error: reason },
    ]);
    if (!decision.resume && decision.reason !== "not-agent") {
      const { projectId, threadId } = this.ids();
      const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
      await project.sendMessage({ threadId, authorKind: "system", authorId: SYSTEM_ID, body: gaveUpMessage(this.getMeta("language") === "tr", decision.reason) });
    }
  }

  /** The wait after an interrupted turn is over: continue it, unless a message already did. */
  async resumeInterrupted(_payload: { taskId: string }): Promise<void> {
    if (!this.getMeta("resume_pending")) return;
    await this.markDirty();
  }

  /** While a turn runs on a person's computer: hands its runner a new GitHub token before the last one expires. */
  async renewGithub(payload: { taskId: string; requester: string | null }): Promise<void> {
    const row = this.runningTask();
    if (!row || row.id !== payload.taskId || row.backend !== "local") return;
    const { runnerId } = JSON.parse(row.spec) as StoredSpec;
    if (!runnerId) return;
    // Null when the repositories were disconnected meanwhile: the last token then runs out by itself.
    const github = await localGithubToken(this.env, this.ids().projectId, runnerId, payload.requester);
    if (!github) return;
    const runner = await getAgentByName(this.env.RUNNER_AGENT, runnerId);
    const sent = await runner.renewGithub(row.id, github);
    if (!sent.ok) return void (await revokeInstallationToken(github.token).catch(() => {}));
    // The last one stays valid until the turn ends or it expires, so a push already under way finishes.
    this.githubTokens.set(row.id, [...(this.githubTokens.get(row.id) ?? []), github.token]);
    await this.schedule(GITHUB_RENEW_SEC, "renewGithub", payload);
  }

  /** The turn ended: its GitHub tokens stop working now rather than within the hour. */
  private async revokeGithub(taskId: string) {
    const tokens = this.githubTokens.get(taskId) ?? [];
    this.githubTokens.delete(taskId);
    await Promise.all(tokens.map((t) => revokeInstallationToken(t).catch((err) => console.warn("revoking a turn's GitHub token failed", err))));
  }

  async taskWatchdog(payload: { taskId: string }): Promise<void> {
    await this.taskEvents(payload.taskId, [
      { type: "done", ok: false, error: "The runner stopped answering, so the task was given up." },
    ]);
  }

  /** The backend a recorded task runs on, for cancelling it. */
  private backendOf(row: TaskRow): Pick<RunnerBackend, "cancel"> {
    if (row.backend === "local") return localCanceller(this.env, (JSON.parse(row.spec) as StoredSpec).runnerId);
    return sandboxBackend(this.env, this.getMeta("thread_id")!);
  }

  /** Status updates in order, so two at once cannot both open a plan card. */
  private statusQueue: Promise<void> = Promise.resolve();

  /**
   * Shows the agent's plan, with the current task's steps nested in it: as the
   * thread's checklist (the progress line on top) and as the plan card in the
   * conversation. A plan with a new title opens a new card; the old one keeps
   * its last state.
   */
  private showStatus(): Promise<void> {
    const run = this.statusQueue.then(() => this.writeStatus());
    this.statusQueue = run.catch((err) => console.error("plan status", err));
    return run;
  }

  private async writeStatus() {
    const projectId = this.getMeta("project_id");
    const threadId = this.getMeta("thread_id");
    if (!projectId || !threadId) return;
    const plan = this.getMeta("plan");
    const statusText = composeStatus(plan ? (JSON.parse(plan) as Plan) : null, this.getMeta("task_checklist"));
    if (statusText === null) return;
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    await project.updateThread(threadId, { statusText });

    const cardId = this.getMeta("plan_card_id");
    const shown = this.getMeta("plan_card_text");
    if (shown === statusText) return;
    const titleOf = (text: string) => text.split("\n", 1)[0];
    if (cardId && shown !== null && titleOf(shown) === titleOf(statusText)) {
      await project.editMessage(cardId, formatPlan(statusText));
      await this.notePlanChanges(projectId, threadId, cardId, planChanges(shown, statusText));
    } else {
      const card = await project.sendMessage({
        threadId,
        authorKind: "agent",
        authorId: THREAD_AGENT_ID,
        body: formatPlan(statusText),
      });
      this.setMeta("plan_card_id", card.id);
      // A new plan has its own card at the end; notes about the old one are done.
      this.deleteMeta("plan_update_id");
      this.deleteMeta("plan_update");
    }
    this.setMeta("plan_card_text", statusText);
  }

  /**
   * Steps added, dropped or failed while the plan card sits further up the
   * conversation get a note at the end, so nobody has to scroll up to see the
   * plan changed. Changes in a row land in the same note; ticks never make one.
   */
  private async notePlanChanges(projectId: string, threadId: string, cardId: string, changes: PlanUpdate) {
    if (!hasChanges(changes)) return;
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const last = await project.lastThreadMessageId(threadId);
    // The card is the last thing in the conversation, so the change is in view already.
    if (last === cardId) return;
    const noteId = this.getMeta("plan_update_id");
    const shown = this.getMeta("plan_update");
    if (noteId && last === noteId && shown) {
      const merged = mergePlanUpdates(JSON.parse(shown) as PlanUpdate, changes);
      this.setMeta("plan_update", JSON.stringify(merged));
      // Changes that cancel out leave the note as it was rather than empty.
      if (hasChanges(merged)) await project.editMessage(noteId, formatPlanUpdate(merged));
      return;
    }
    const note = await project.sendMessage({ threadId, authorKind: "agent", authorId: THREAD_AGENT_ID, body: formatPlanUpdate(changes) });
    this.setMeta("plan_update_id", note.id);
    this.setMeta("plan_update", JSON.stringify(changes));
  }

  private ids() {
    const projectId = this.getMeta("project_id");
    const threadId = this.getMeta("thread_id");
    if (!projectId || !threadId) throw new Error("This thread is not set up yet.");
    return { projectId, threadId };
  }

  private async publishTask(taskId: string) {
    const [row] = this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${taskId}`;
    const projectId = this.getMeta("project_id");
    if (!row || !projectId) return;
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    await project.broadcastTask({ type: "task.updated", task: this.toTask(row) });
  }

  /** Why a running cloud turn must stop now (its plan's limits, counting the turn so far), or null. */
  private async overLimit(row: TaskRow): Promise<string | null> {
    const spec = JSON.parse(row.spec) as StoredSpec;
    const progress = JSON.parse(row.progress) as TaskProgress;
    const modelMicros = (spec.model && taskCostMicros(this.env, spec.model.id, progress.usage)) || 0;
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(row.created_at)) / 1000));
    const unpricedCalls = this.unpricedCalls(row.id);
    const check = await canUseSandbox(this.env, this.ids().projectId, { modelMicros, seconds, unpricedCalls }).catch((err) => {
      console.error("sandbox limit check", err);
      return { ok: true } as const;
    });
    return check.ok ? null : check.reason;
  }

  private runningTask(): TaskRow | null {
    const [row] = this.sql<TaskRow>`SELECT * FROM tasks WHERE status = 'running' LIMIT 1`;
    return row ?? null;
  }

  /** The project's local folder on the computer the running task is on (the default one for a task from before). */
  private async runningWorkspace(): Promise<ProjectWorkspace | null> {
    const row = this.runningTask();
    const runnerId = row?.backend === "local" ? (JSON.parse(row.spec) as StoredSpec).runnerId : undefined;
    return getWorkspace(this.env, this.ids().projectId, { runnerId });
  }

  /**
   * The work this thread's cloud tasks saved: history and one folder or file, on the branch of
   * the latest sandbox task unless `ref` is given. Null when nothing was saved. Callable over RPC.
   */
  async readWorkspace(path = "", ref?: string): Promise<WorkspaceView | null> {
    const [row] = this.sql<TaskRow>`SELECT * FROM tasks WHERE backend = 'sandbox' ORDER BY created_at DESC LIMIT 1`;
    if (!row) return null;
    const branch = ref || workingBranch(JSON.parse(row.spec) as StoredSpec);
    return readWorkspace(this.env, this.ids().threadId, branch, path);
  }

  private taskRows(): TaskRow[] {
    return this.sql<TaskRow>`SELECT * FROM tasks ORDER BY created_at`;
  }

  private taskLog(taskId: string, limit = MAX_LOG_LINES): TerminalLine[] {
    return this.sql<LogRow>`SELECT stream, text, at, ms, tool FROM task_log WHERE task_id = ${taskId} ORDER BY id DESC LIMIT ${limit}`
      .reverse()
      .map((r) => ({
        stream: r.stream,
        text: r.text,
        ...(r.at !== null && { at: r.at }),
        ...(r.ms !== null && { ms: r.ms }),
        ...(r.tool && { tool: true }),
      }));
  }

  private toTask(row: TaskRow): Task {
    const spec = JSON.parse(row.spec) as StoredSpec;
    return {
      id: row.id,
      threadId: this.getMeta("thread_id") ?? "",
      title: spec.title,
      harness: spec.harness,
      backend: row.backend,
      status: row.status,
      prUrl: row.pr_url,
      summary: row.summary,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    };
  }

  /**
   * Threads that ran tasks on a person's computer before tasks were unified
   * kept them in an older `tasks` table. Moves them into the current one.
   */
  /** Terminal lines got their time, duration and tool flag later; older threads gain the columns. */
  private migrateLogTimes() {
    const columns = new Set(this.sql<{ name: string }>`PRAGMA table_info(task_log)`.map((c) => c.name));
    if (!columns.has("at")) this.sql`ALTER TABLE task_log ADD COLUMN at INTEGER`;
    if (!columns.has("ms")) this.sql`ALTER TABLE task_log ADD COLUMN ms INTEGER`;
    if (!columns.has("tool")) this.sql`ALTER TABLE task_log ADD COLUMN tool INTEGER`;
  }

  private migrateLocalTasks() {
    const columns = this.sql<{ name: string }>`PRAGMA table_info(tasks)`;
    if (!columns.some((c) => c.name === "runner_id")) return;
    type OldRow = { id: string; runner_id: string; prompt: string; status: TaskStatus; result: string | null; created_at: string; seen: number };
    const old = this.sql<OldRow>`SELECT * FROM tasks`;
    this.sql`DROP TABLE tasks`;
    this.sql`CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      spec TEXT NOT NULL,
      backend TEXT NOT NULL,
      status TEXT NOT NULL,
      progress TEXT NOT NULL,
      summary TEXT,
      pr_url TEXT,
      language TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL,
      finished_at TEXT,
      reported INTEGER NOT NULL DEFAULT 0
    )`;
    for (const t of old) {
      const title = t.prompt.split("\n")[0]!.slice(0, 80) || "Task";
      const spec = { taskId: t.id, title, prompt: t.prompt, harness: "cli", runnerId: t.runner_id, openPr: false, timeoutSec: 1800 };
      const finished = t.status === "running" ? null : { ok: t.status === "done" };
      const progress = [...LOCAL_PHASES, ...(finished ? [{ type: "done" as const, ...finished }] : [])].reduce(reduceTask, {
        ...emptyProgress(),
        lastText: t.result,
      });
      this.sql`INSERT INTO tasks (id, spec, backend, status, progress, summary, created_at, reported)
        VALUES (${t.id}, ${JSON.stringify(spec)}, ${"local"}, ${t.status}, ${JSON.stringify(progress)}, ${t.result},
          ${t.created_at}, ${t.seen})`;
    }
  }

  private getMeta(key: string): string | null {
    const [row] = this.sql<{ value: string }>`SELECT value FROM meta WHERE key = ${key}`;
    return row?.value ?? null;
  }

  private deleteMeta(key: string) {
    this.sql`DELETE FROM meta WHERE key = ${key}`;
  }

  private setMeta(key: string, value: string) {
    this.sql`INSERT INTO meta (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  }
}

/** A short result message for a task the agent did not report on itself, in the task's language. */
function taskReport(title: string, row: TaskRow, log: TerminalLine[]): string {
  const tr = row.language.toLowerCase().startsWith("tr");
  const outcome =
    row.status === "done"
      ? tr ? "tamamlandı" : "finished"
      : row.status === "cancelled"
        ? tr ? "durduruldu" : "was cancelled"
        : tr ? "başarısız oldu" : "failed";
  const parts = [tr ? `"${title}" görevi ${outcome}.` : `The task "${title}" ${outcome}.`];
  if (row.summary) parts.push(row.summary);
  if (row.pr_url) parts.push(row.pr_url);
  const tail = log.map((l) => l.text).join("\n").trim();
  if (tail) parts.push(`${tr ? "Son çıktı" : "Last output"}:\n\n\`\`\`\n${tail.slice(-3000)}\n\`\`\``);
  return parts.join("\n\n");
}

/** Whether the person is (still) a member of the project. */
async function isMember(env: Env, projectId: string, userId: string): Promise<boolean> {
  return Boolean(
    await env.DB.prepare("SELECT 1 AS y FROM project_members WHERE project_id = ? AND user_id = ?").bind(projectId, userId).first(),
  );
}
