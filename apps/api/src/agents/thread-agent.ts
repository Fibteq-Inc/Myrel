import {
  type AgentConnector,
  type Attachment,
  type ArtifactRef,
  CLI_NAMES,
  type CliUsage,
  createId,
  formatPlan,
  type MessageStats,
  type Task,
  type TaskStatus,
  type TerminalLine,
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
import { Agent, getAgentByName } from "agents";
import { readSecrets, remoteTarget, type TurnConnector, turnConnectors } from "../connectors/store";
import { canUseSandbox } from "../extensions";
import { listRepoFiles, readRepoFile } from "../github/files";
import { listPullRequests, trackPullRequest } from "../github/pulls";
import { listProjectRepos } from "../github/store";
import { projectTaskModel } from "../keys";
import { handleMcp, type Tool } from "../llm";
import { runnerHasFeature } from "../runners";
import { localBackend, localCanceller, projectGithubToken, sandboxBackend, type TaskPlace, taskPlace } from "../sandbox/backend";
import { readWorkspace, threadWorkspace, type WorkspaceView } from "../sandbox/workspace";
import { recordSandboxRun, recordTaskUsage, taskCostMicros, taskRuntime } from "../usage";
import { type AgentPlace, agentPrompt, hashAgentToken, newAgentToken, pullRequestUrls, sameHash } from "./harness-agent";
import { type Author, knowledgeTools, signFileLink } from "./knowledge";
import { composeStatus, type Plan } from "./plan";
import { THREAD_AGENT_ID, SYSTEM_ID } from "./names";
import type { ThreadWake } from "./project-agent";
import { routineTools } from "./routine-tools";
import type { TaskWithLog } from "./thread-tasks";
import { type CoordinatorNote, type ReplyNeeds, type RoutineRun, threadPrompt, threadTools } from "./thread-worker";

const BY: Author = { kind: "agent", id: THREAD_AGENT_ID };

export type ThreadStart = { projectId: string; threadId: string; brief: string };

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
type StoredSpec = Omit<TaskSpec, "harness"> & { harness: string; runnerId?: string; agent?: boolean };

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
  resolved: boolean;
  timezone: string;
  /** Where the last stats line stopped counting; the next message's line starts here. Absent on older turns. */
  mark?: StatsMark;
  /** Its latest reply and where that reply's line started, so the usage after it can join it when the turn ends. */
  lastReplyStats?: { id: string; from: StatsMark };
};

/** The runner protocol's limit for a task's prompt, less room for the agent's instructions. */
const MAX_AGENT_PROMPT = 90_000;
/** How long one agent turn may run. */
const AGENT_TURN_SEC = 3600;

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

/**
 * One instance per thread (named by thread id). Each wake queues a turn of the
 * thread's agent: a coding harness (see harness-agent.ts) that gets the thread
 * as its prompt and acts through Myrel's tools over MCP (agentMcp). Messages
 * themselves live in the ProjectAgent; this DO keeps the brief, coordinator
 * notes, a read cursor, and each turn's run (on the person's computer or in
 * the sandbox) with its progress and terminal output.
 */
export class ThreadAgent extends Agent<Env> {
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
  }

  /** Called by the ProjectAgent when the coordinator opens this thread. */
  async start(input: ThreadStart): Promise<void> {
    this.setMeta("project_id", input.projectId);
    this.setMeta("thread_id", input.threadId);
    this.setMeta("brief", input.brief);
    await this.markDirty();
  }

  /**
   * A person wrote in the thread, the coordinator sent a note, a routine ran, or one of the
   * thread's pull requests changed on GitHub. Task results come through taskEvents.
   */
  async wake(reason: ThreadWake): Promise<void> {
    if (reason.kind === "coordinator") {
      this.sql`INSERT INTO notes (body, created_at) VALUES (${reason.note}, ${new Date().toISOString()})`;
    }
    if (reason.kind === "github") {
      this.sql`INSERT INTO github_events (body, created_at) VALUES (${reason.event}, ${new Date().toISOString()})`;
    }
    if (reason.kind === "routine") {
      this.sql`INSERT INTO routine_runs (name, prompt, created_at)
        VALUES (${reason.name}, ${reason.prompt}, ${new Date().toISOString()})`;
    }
    await this.markDirty();
  }

  private async markDirty() {
    this.setMeta("dirty", "1");
    await this.queue("threadTurn", null);
  }

  /** Queue callback. Turns run one at a time; wakes during a turn get their own turn after it. */
  async threadTurn(): Promise<void> {
    if (this.getMeta("dirty") !== "1") return;
    // The agent is mid-turn; this wake waits for it (finishAgentTurn queues the next turn).
    if (this.runningTask()) return;
    this.setMeta("dirty", "0");
    const projectId = this.getMeta("project_id");
    const threadId = this.getMeta("thread_id");
    if (!projectId || !threadId) return;

    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const ctx = await project.getThreadContext(threadId);
    if (!ctx) return;

    const place = await taskPlace(this.env, projectId);
    if (place.kind === "error") return this.cannotWork(place.message);
    // Runners before 0.5.0 can host only Claude Code as the agent.
    const needs = place.kind === "local" && place.workspace.cli !== "claude" ? "agent-clis" : "agent";
    if (place.kind === "local" && !(await runnerHasFeature(this.env, place.workspace.runnerId, needs))) {
      return this.cannotWork(
        `myrel-runner on "${place.workspace.runnerName}" is too old to work this thread. Update it with \`npx myrel-runner@latest update\`, then write here again.`,
      );
    }

    const noteRows = this.sql<NoteRow>`SELECT * FROM notes ORDER BY id`;
    const notes: CoordinatorNote[] = noteRows.map((n) => ({ body: n.body, createdAt: n.created_at, isNew: n.seen === 0 }));
    const lastSeenSeq = Number(this.getMeta("last_seen_seq") ?? 0);
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
    this.sql`UPDATE notes SET seen = 1`;
    this.sql`UPDATE routine_runs SET seen = 1`;
    this.sql`UPDATE github_events SET seen = 1`;
    this.setMeta("last_seen_seq", String(ctx.messages.at(-1)?.seq ?? lastSeenSeq));
    const prompt = threadPrompt({
      ...ctx,
      brief: this.getMeta("brief") ?? "",
      lastSeenSeq,
      notes,
      artifacts: await project.listArtifacts(),
      repos: await listProjectRepos(this.env.DB, projectId),
      routineRuns,
      githubEvents,
      pullRequests: await listPullRequests(this.env.DB, projectId, threadId),
      now: new Date(),
    });
    const lastHuman = [...ctx.messages].reverse().find((m) => m.authorKind === "user") ?? ctx.root;
    // The person the thread works for: their own connectors are on for it.
    const requester = [ctx.root, ...ctx.messages].reverse().find((m) => m.authorKind === "user")?.authorId ?? null;
    await this.startAgentTurn({
      prompt,
      requester,
      place,
      timezone: ctx.defaultTimezone,
      language: /[çğıöşüÇĞİÖŞÜ]/.test(lastHuman.body) ? "tr" : "en",
      attachments: [ctx.root, ...ctx.messages].flatMap((m) => m.attachments ?? []),
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
    place: Exclude<TaskPlace, { kind: "error" }>;
    timezone: string;
    language: string;
    /** Files attached to the thread's messages, oldest first: a cloud turn finds them already downloaded. */
    attachments: Attachment[];
    /** Who the thread works for, whose own connectors it may use. */
    requester: string | null;
  }) {
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const { place, language } = input;
    const { token, hash } = await newAgentToken();
    const agentPlace: AgentPlace =
      place.kind === "local"
        ? { kind: "local", cli: place.workspace.cli, folder: place.workspace.path, computer: place.workspace.runnerName }
        : { kind: "cloud", images: false };
    // A very long thread keeps its newest part; a resumed CLI session remembers the rest.
    const context = input.prompt.length > MAX_AGENT_PROMPT ? `(older context cut)\n${input.prompt.slice(-MAX_AGENT_PROMPT)}` : input.prompt;
    const taskId = createId("task");
    const turn: AgentTurn = {
      pending: [],
      replied: false,
      needs: null,
      asked: false,
      resolved: false,
      timezone: input.timezone,
      mark: { at: Date.now(), inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
    this.setMeta("agent_turn", JSON.stringify(turn));
    this.setMeta("agent_token", hash);
    this.deleteMeta("task_checklist");
    await project.updateThread(threadId, { status: "working" });
    await project.setActivity(threadId, true);
    try {
      const mcpPath = `/api/agent-mcp/${threadId}`;
      const connectors = await this.turnConnectors(place, input.requester);
      const infos = connectors.map((c) => ({ name: c.name, title: c.title }));
      const spec = TaskSpec.parse({ taskId, title: "OpenCode", prompt: agentPrompt(agentPlace, context, infos), timeoutSec: AGENT_TURN_SEC });
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
        const agent = { mcpPath, token, ...(local.length && { connectors: local }) };
        const backend = localBackend(this.env, { projectId, threadId, workspace, agent });
        const unavailable = backend.unavailable(spec);
        if (unavailable) throw new Error(unavailable);
        // The person's own CLI does the work, so the run shows that CLI.
        const run = { ...spec, title: CLI_NAMES[workspace.cli] };
        await this.launch(stored(run, { harness: workspace.cli, runnerId: workspace.runnerId }), backend.id, () => backend.start(run, {}), language);
        await this.taskEvents(taskId, LOCAL_PHASES);
      } else {
        const allowed = await canUseSandbox(this.env, projectId);
        if (!allowed.ok) throw new Error(allowed.reason);
        const origin = await project.publicOrigin();
        if (!origin) throw new Error("This server does not know its own address yet, so the sandbox cannot reach it. Its admin needs to set BETTER_AUTH_URL.");
        const model = await projectTaskModel(this.env, projectId);
        if (!model.ok) throw new Error(model.reason);
        spec.model = model.model;
        spec.prompt = agentPrompt({ kind: "cloud", images: model.model.images ?? false }, context, infos);
        const secrets: Record<string, string> = { MYREL_MODEL_API_KEY: model.apiKey, MYREL_MCP_TOKEN: token };
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
        const github = await projectGithubToken(this.env, projectId, spec.timeoutSec);
        if (github) secrets.GITHUB_TOKEN = github;
        const files = await this.attachmentLinks(origin, input.attachments);
        if (files.length) secrets.MYREL_FILES = JSON.stringify(files);
        const backend = sandboxBackend(this.env, threadId);
        const unavailable = backend.unavailable(spec);
        if (unavailable) throw new Error(unavailable);
        // The sandbox's disk does not outlive it; the thread's workspace keeps the work between turns.
        const workspace = await threadWorkspace(this.env, threadId, spec.timeoutSec + WATCHDOG_GRACE_SEC);
        if (workspace) {
          spec.workspace = { remote: workspace.remote };
          secrets.MYREL_WORKSPACE_TOKEN = workspace.token;
        }
        await this.launch(stored(spec), backend.id, () => backend.start(spec, secrets), language);
        if (!workspace && (this.env as Partial<Env>).WORKSPACES) {
          await this.taskEvents(taskId, [
            { type: "log", stream: "system", text: "This thread's workspace could not be opened, so this turn's work will not be saved for the next one." },
          ]);
        }
      }
      await this.schedule(spec.timeoutSec + WATCHDOG_GRACE_SEC, "taskWatchdog", { taskId });
    } catch (err) {
      // Once recorded, launch() finished the run as failed and finishAgentTurn reported it.
      if (!this.sql<TaskRow>`SELECT * FROM tasks WHERE id = ${taskId}`[0]) {
        this.deleteMeta("agent_token");
        this.deleteMeta("agent_turn");
        this.deleteMeta("agent_connectors");
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
    const turn = JSON.parse(this.getMeta("agent_turn") ?? "null") as AgentTurn | null;
    this.deleteMeta("agent_token");
    this.deleteMeta("agent_turn");
    this.deleteMeta("agent_connectors");
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    let pending = turn?.pending ?? [];
    const replied = turn?.replied ?? false;
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
    const asked = turn?.asked ?? false;
    const failed = row.status === "failed" && !replied;
    await project.updateThread(threadId, {
      status: resolved ? "done" : asked ? "blocked" : failed ? "failed" : "review_ready",
      resolved,
    });
    const kind = failed ? "failed" : resolved ? "done" : (turn?.needs ?? ((replied || lastText) && !asked ? "ready" : null));
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
   * The connectors this turn's agent gets (see turnConnectors), remembered so the gateway knows
   * which remote ones the turn's token opens. None from a runner too old to pass them on.
   */
  private async turnConnectors(place: Exclude<TaskPlace, { kind: "error" }>, requester: string | null): Promise<TurnConnector[]> {
    const { projectId } = this.ids();
    if (place.kind === "local" && !(await runnerHasFeature(this.env, place.workspace.runnerId, "connectors"))) return [];
    const connectors = await turnConnectors(this.env, { projectId, userId: requester, place: place.kind }).catch((err) => {
      console.error("connectors", err);
      return [];
    });
    this.setMeta("agent_connectors", JSON.stringify(connectors.map((c) => ({ id: c.id, name: c.name, transport: c.transport }))));
    return connectors;
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

  /** Myrel's thread tools for the agent, acting on this thread and recording what the turn did. */
  private async agentToolset(): Promise<Tool[]> {
    const { projectId, threadId } = this.ids();
    const project = await getAgentByName(this.env.PROJECT_AGENT, projectId);
    const turn = () => JSON.parse(this.getMeta("agent_turn") ?? "null") as AgentTurn;
    const save = (patch: Partial<AgentTurn>) => this.setMeta("agent_turn", JSON.stringify({ ...turn(), ...patch }));
    const track = (url: string) => trackPullRequest(this.env, projectId, threadId, url);
    return [
      ...threadTools({
        reply: async (text, needs, files) => {
          // Checked before anything is sent, so a wrong path fails the call and the agent can fix it.
          const attachments = files?.length ? await project.attachmentsFor(files) : [];
          const t = turn();
          const row = this.runningTask();
          const counted = row ? this.runStats(row, t.mark) : null;
          save({ pending: [], replied: true, lastReply: text, needs: needs ?? t.needs, ...(counted && { mark: counted.mark }) });
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
          // Its own reply is not news next turn, unless someone wrote in between (then that stays NEW).
          if (m.seq === Number(this.getMeta("last_seen_seq") ?? 0) + 1) this.setMeta("last_seen_seq", String(m.seq));
          // A pull request it links to is followed even when it forgot track_pull_request.
          for (const url of pullRequestUrls(text)) await track(url).catch((err) => console.warn("tracking pull request failed", url, err));
          return m;
        },
        publishArtifact: async (input) => {
          const result = await project.publishArtifact({ ...input, threadId });
          if ("error" in result) throw new Error(result.error);
          const { artifact } = result;
          const ref = { artifactId: artifact.id, version: artifact.version, title: artifact.title };
          save({ pending: [...turn().pending.filter((p) => p.artifactId !== artifact.id), ref] });
          return artifact;
        },
        setPlan: async (plan) => {
          this.setMeta("plan", JSON.stringify(plan));
          await this.showStatus();
        },
        requestCoordinator: async (kind, reason) => {
          save({ asked: true });
          await project.requestCoordinator(threadId, kind, reason);
        },
        resolve: async () => save({ resolved: true }),
        listRepoFiles: (repo, path, ref) => listRepoFiles(this.env, projectId, repo, path, ref),
        readRepoFile: (repo, path, ref) => readRepoFile(this.env, projectId, repo, path, ref),
        trackPullRequest: async (url) => {
          const pr = await track(url);
          if (!pr) throw new Error("That is not a pull request on a repository connected to this project.");
          return `Following ${pr.repo}#${pr.number}: its state shows in the thread, and CI failures, reviews and the merge will wake you.`;
        },
      }),
      ...knowledgeTools({
        memoryRead: (name: string) => project.getMemory(name),
        memoryWrite: (name: string, description: string, content: string) => project.putMemory(name, { description, content }, BY),
        memoryDelete: (name: string) => project.deleteMemory(name),
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
        createRoutine: (input: Parameters<typeof project.createRoutine>[0]) => project.createRoutine(input, "agent"),
        setPaused: (id: string, paused: boolean) => project.updateRoutine(id, { paused }),
        deleteRoutine: (id: string) => project.deleteRoutine(id),
        defaultTimezone: turn()?.timezone ?? "UTC",
        threadId,
      }),
    ];
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
        await recordTaskUsage(this.env, ctx, progress.usage, ms).catch((err) => console.error("task usage", err));
      }
      if (row.backend === "sandbox") {
        const run = { taskId, projectId, threadId, startedAt: new Date(row.created_at), endedAt: new Date() };
        await recordSandboxRun(this.env.DB, run).catch((err) => console.error("sandbox run", err));
      }
      await this.publishTask(taskId);
      // From now on the webhook keeps the pull request's state current and wakes this thread on CI and reviews.
      if (progress.prUrl) {
        await trackPullRequest(this.env, projectId, threadId, progress.prUrl).catch((err) =>
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
      await this.backendOf(row).cancel(taskId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
    } else {
      const card = await project.sendMessage({
        threadId,
        authorKind: "agent",
        authorId: THREAD_AGENT_ID,
        body: formatPlan(statusText),
      });
      this.setMeta("plan_card_id", card.id);
    }
    this.setMeta("plan_card_text", statusText);
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

  private runningTask(): TaskRow | null {
    const [row] = this.sql<TaskRow>`SELECT * FROM tasks WHERE status = 'running' LIMIT 1`;
    return row ?? null;
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
