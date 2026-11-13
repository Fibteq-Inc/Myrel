import { createDb, schema } from "@myrel/db";
import { createId, formatResearch, type Message, type ResearchStep } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { eq } from "drizzle-orm";
import { wrapExternal } from "../agents/external";
import type { Author } from "../agents/knowledge";
import { SYSTEM_ID, THREAD_AGENT_ID } from "../agents/names";
import type { ThreadWake } from "../agents/project-agent";
import type { ReplyNeeds } from "../agents/thread-worker";
import { personKey, personKeyById } from "../keys";
import {
  denyWaiting,
  interruptResearch,
  RESEARCH_MODEL,
  type ResearchClient,
  type ResearchProgress,
  raiseBudget,
  researchClient,
  researchError,
  researchActivity,
  researchProgress,
  researchReport,
  startResearch,
} from "./managed";
import {
  nextPollSec,
  noteReport,
  RESEARCH_DEFAULT_BUDGET_USD,
  RESEARCH_MAX_RUN_SEC,
  RESEARCH_POLL_FIRST_SEC,
  RESEARCH_POLL_SEC,
  type ResearchRequest,
  type ResearchState,
  researchAskMessage,
  researchBudgetAnswer,
  researchBudgetForbiddenMessage,
  researchBudgetMessage,
  researchFile,
  researchNoKeyMessage,
  researchNote,
  researchPath,
  researchStartAnswer,
  researchStartFailedMessage,
  RESEARCH_CARD_STEPS,
  reportSummary,
  researchCard,
  stepCents,
  usd,
} from "./research";

/**
 * A thread's research (start_research), run for its ThreadAgent: the card, the start on the
 * approver's own key, the scheduled looks at the run, the budget card and the end (see research.ts
 * for the decisions behind it). The state lives in the thread's meta under "research"; one at a time.
 * Kept out of thread-agent.ts, which is large enough already.
 */

/** What a research needs of its thread. */
export type ResearchHost = {
  env: Env;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  deleteMeta(key: string): void;
  ids(): { projectId: string; threadId: string };
  language(): string;
  /** Calls pollResearch with `payload` after `sec` seconds. */
  schedule(sec: number, payload: { id: string }): Promise<void>;
  /** Wakes the thread's agent with a note. */
  wake(note: string): Promise<void>;
  markExternal(source: string): Promise<void>;
};

const BY: Author = { kind: "agent", id: THREAD_AGENT_ID };

export function readResearch(host: ResearchHost): ResearchState | null {
  return JSON.parse(host.getMeta("research") ?? "null") as ResearchState | null;
}

/** start_research: the card that asks people first. The research starts when someone taps "Start" (answerResearch). */
export async function requestResearch(host: ResearchHost, input: ResearchRequest, reply: (text: string, needs?: ReplyNeeds) => Promise<Message>): Promise<string> {
  const open = readResearch(host);
  if (open?.status === "asking") return `A card already asks people to start the research "${open.title}". End your turn; its report will wake you once it runs.`;
  if (open) return `The research "${open.title}" is still running; its report will wake you. One research at a time: end your turn.`;
  const budgetCents = Math.round((input.budgetUsd ?? RESEARCH_DEFAULT_BUDGET_USD) * 100);
  const draft = { title: input.title.trim(), question: input.question.trim(), budgetCents };
  const m = await reply(researchAskMessage(draft, input.why ?? "", host.language()), "decision");
  host.setMeta("research", JSON.stringify({ id: createId("research"), ...draft, status: "asking", askMessageId: m.id } satisfies ResearchState));
  return `A card asks people to start the research "${draft.title}" (up to ${usd(budgetCents, "en")}, paid from the own Anthropic key of whoever approves it). End your turn now: once it runs, its report wakes you. If they decline, their answer wakes you.`;
}

/**
 * A person answered a research card. "Start" starts it on their own Anthropic key, "Add" raises the
 * budget (only for the person who approved it), "Finish" keeps what it has; none of these needs a
 * turn. "Don't start it" goes to the agent like any message. Returns true when it needs no turn.
 */
export async function answerResearch(host: ResearchHost, reason: Extract<ThreadWake, { kind: "message" }>): Promise<boolean> {
  const state = readResearch(host);
  if (!state || state.status === "running") return false;
  const onCard = (id: string | undefined) => !reason.pick || reason.pick.messageId === id;
  const start = state.status === "asking" && onCard(state.askMessageId) ? researchStartAnswer(reason.body ?? "", state.budgetCents) : null;
  const budget = state.status === "budget" && onCard(state.budgetMessageId) ? researchBudgetAnswer(reason.body ?? "", state.budgetCents) : null;
  if (!start && !budget) return false;
  if (start === "skip") {
    host.deleteMeta("research");
    return false;
  }
  const { projectId, threadId } = host.ids();
  const project = await getAgentByName(host.env.PROJECT_AGENT, projectId);
  const language = host.language();
  let body: string | null = null;
  if (start === "start") {
    // A second tap while the first one is still starting it starts nothing more.
    const starting = Number(host.getMeta("research_starting") ?? 0);
    if (Date.now() - starting < 2 * 60_000) return true;
    host.setMeta("research_starting", String(Date.now()));
    try {
      body = reason.authorId ? await begin(host, state, reason.authorId) : researchNoKeyMessage(language);
    } finally {
      host.deleteMeta("research_starting");
    }
  } else if (budget === "raise") {
    if (reason.authorId !== state.approver) {
      body = researchBudgetForbiddenMessage(language);
    } else {
      body = await raise(host, state);
    }
  } else if (budget === "finish") {
    await endResearch(host, state, { phase: "budget" });
  }
  const line = body ? await project.sendMessage({ threadId, authorKind: "system", authorId: SYSTEM_ID, body }) : null;
  const seen = line?.seq ?? reason.seq;
  // Neither the answer nor the line after it is news for the next turn, unless someone wrote in between.
  if (reason.seq !== undefined && seen !== undefined && reason.seq === Number(host.getMeta("last_seen_seq") ?? 0) + 1 && seen <= reason.seq + 1) {
    host.setMeta("last_seen_seq", String(seen));
    await project.updateThread(threadId, { seenSeq: seen });
  }
  return true;
}

/** Starts the research on the approver's own key. Returns the line to show when it did not start. */
async function begin(host: ResearchHost, state: ResearchState, approver: string): Promise<string | null> {
  const language = host.language();
  const key = await personKey(host.env, approver, "anthropic").catch((err) => {
    console.error("could not read the approver's Anthropic key", err);
    return null;
  });
  if (!key) return researchNoKeyMessage(language);
  const { projectId, threadId } = host.ids();
  let sessionId: string;
  try {
    sessionId = await startResearch(researchClient(key.secret), {
      title: state.title,
      question: state.question,
      budgetCents: state.budgetCents,
      metadata: { myrel_research: state.id },
    });
  } catch (err) {
    const e = researchError(err);
    console.warn("research did not start", e.kind, e.message);
    return researchStartFailedMessage(e.kind, e.message, language);
  }
  const [user] = await createDb(host.env.DB).select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, approver));
  const project = await getAgentByName(host.env.PROJECT_AGENT, projectId);
  const running: ResearchState = {
    ...state,
    status: "running",
    approver,
    approverName: user?.name ?? undefined,
    keyId: key.id,
    sessionId,
    spentCents: 0,
    startedAt: new Date().toISOString(),
  };
  const m = await project.sendMessage({ threadId, authorKind: "agent", authorId: THREAD_AGENT_ID, body: formatResearch(researchCard(running)) });
  const started: ResearchState = { ...running, cardMessageId: m.id };
  host.setMeta("research", JSON.stringify(started));
  await record(host, started);
  await host.schedule(RESEARCH_POLL_FIRST_SEC, { id: state.id });
  return null;
}

/** The approver let a run paused at its budget go on, by as much again (at most the default). */
async function raise(host: ResearchHost, state: ResearchState): Promise<string | null> {
  const client = await clientFor(host, state);
  if (!client || !state.sessionId) {
    await endResearch(host, state, { phase: "failed", reason: host.language() === "tr" ? "anahtar artık yok" : "the key is gone" });
    return null;
  }
  const budgetCents = state.budgetCents + stepCents(state.budgetCents);
  try {
    await raiseBudget(client, state.sessionId, budgetCents);
  } catch (err) {
    const e = researchError(err);
    console.warn("research budget not raised", e.message);
    return researchStartFailedMessage(e.kind, e.message, host.language());
  }
  const running: ResearchState = { ...state, status: "running", budgetCents, budgetMessageId: undefined };
  host.setMeta("research", JSON.stringify(running));
  await showCard(host, running);
  await host.schedule(RESEARCH_POLL_FIRST_SEC, { id: state.id });
  return null;
}

async function clientFor(host: ResearchHost, state: ResearchState): Promise<ResearchClient | null> {
  if (!state.approver || !state.keyId) return null;
  const secret = await personKeyById(host.env, state.approver, state.keyId).catch((err) => {
    console.error("could not read the research key", err);
    return null;
  });
  return secret ? researchClient(secret) : null;
}

type CardEnd = Parameters<typeof researchCard>[1];

/** The research's card in the thread, and its row in the project's list, as it stands now. */
async function showCard(host: ResearchHost, state: ResearchState, end?: CardEnd): Promise<void> {
  if (state.cardMessageId) {
    const project = await getAgentByName(host.env.PROJECT_AGENT, host.ids().projectId);
    await project.editMessage(state.cardMessageId, formatResearch(researchCard(state, end))).catch((err) => console.warn("research card not edited", err));
  }
  await record(host, state, end);
}

async function record(host: ResearchHost, state: ResearchState, end?: CardEnd): Promise<void> {
  const { projectId, threadId } = host.ids();
  const card = researchCard(state, end);
  const project = await getAgentByName(host.env.PROJECT_AGENT, projectId);
  await project
    .recordResearch({
      id: card.id,
      threadId,
      title: card.title,
      status: card.status,
      ...(card.partial && { partial: card.partial }),
      spentCents: card.spentCents,
      budgetCents: card.budgetCents,
      ...(card.approverName && { approverName: card.approverName }),
      startedAt: card.startedAt,
      ...(card.endedAt && { endedAt: card.endedAt }),
      ...(card.report && { report: card.report }),
    })
    .catch((err) => console.warn("research not recorded", err));
}

/** The searches and reads since the last look, folded into the state; null when there were none. */
async function withActivity(client: ResearchClient, state: ResearchState): Promise<ResearchState | null> {
  if (!state.sessionId) return null;
  const steps = await researchActivity(client, state.sessionId, state.activityAt).catch((err) => {
    console.warn("research activity", err);
    return [];
  });
  const seen = new Set(state.seenIds ?? []);
  const fresh = steps.filter((s) => !seen.has(s.id));
  if (!fresh.length) return null;
  const last = fresh[fresh.length - 1]!;
  const newest: ResearchStep[] = fresh
    .slice(-RESEARCH_CARD_STEPS)
    .reverse()
    .map((s) => ({ kind: s.kind, text: s.text }));
  return {
    ...state,
    searches: (state.searches ?? 0) + fresh.filter((s) => s.kind === "search").length,
    pages: (state.pages ?? 0) + fresh.filter((s) => s.kind === "read").length,
    steps: [...newest, ...(state.steps ?? [])].slice(0, RESEARCH_CARD_STEPS),
    activityAt: last.at,
    // Ids at the newest time come again next look (created_at[gte]); older ones never do.
    seenIds: [...(state.seenIds ?? []), ...fresh.map((s) => s.id)].slice(-50),
  };
}

/** Scheduled while a research runs: its spend on the status line, and its end. */
export async function pollResearch(host: ResearchHost, payload: { id: string }): Promise<void> {
  const state = readResearch(host);
  if (!state || state.id !== payload.id || state.status !== "running" || !state.sessionId) return;
  const client = await clientFor(host, state);
  if (!client) {
    await endResearch(host, state, { phase: "failed", reason: host.language() === "tr" ? "onaylayanın anahtarı silindi" : "the approver's key was deleted" });
    return;
  }
  let progress: ResearchProgress;
  try {
    progress = await researchProgress(client, state.sessionId);
  } catch (err) {
    const e = researchError(err);
    console.warn("research progress", e.kind, e.message);
    if (e.kind === "key") {
      await endResearch(host, state, { phase: "failed", reason: e.message.slice(0, 200) });
      return;
    }
    // A passing error: look again later.
    await host.schedule(RESEARCH_POLL_SEC, { id: state.id });
    return;
  }
  const now = Date.now();
  const ranSec = state.startedAt ? (now - Date.parse(state.startedAt)) / 1000 : 0;
  if (progress.phase === "running" || progress.phase === "waiting") {
    if (progress.phase === "waiting") await denyWaiting(client, state.sessionId, progress.waitingOn ?? []).catch((err) => console.warn("research deny", err));
    let next = (await withActivity(client, state)) ?? state;
    if (ranSec > RESEARCH_MAX_RUN_SEC && !state.interruptedAt) {
      await interruptResearch(client, state.sessionId).catch((err) => console.warn("research interrupt", err));
      next = { ...next, interruptedAt: new Date(now).toISOString() };
    }
    if (progress.spentCents !== state.spentCents) next = { ...next, spentCents: progress.spentCents };
    if (next !== state) {
      // A person may have stopped it while this look was under way.
      const latest = readResearch(host);
      if (latest?.stoppedBy) next = { ...next, stoppedBy: latest.stoppedBy, interruptedAt: latest.interruptedAt };
      host.setMeta("research", JSON.stringify(next));
      await showCard(host, next);
    }
    await host.schedule(nextPollSec(state.startedAt, now), { id: state.id });
    return;
  }
  const current: ResearchState = { ...((await withActivity(client, state)) ?? state), spentCents: progress.spentCents };
  if (progress.phase === "budget") {
    const { projectId, threadId } = host.ids();
    const project = await getAgentByName(host.env.PROJECT_AGENT, projectId);
    const paused: ResearchState = { ...current, status: "budget" };
    await showCard(host, paused);
    const m = await project.sendMessage({ threadId, authorKind: "agent", authorId: THREAD_AGENT_ID, body: researchBudgetMessage(current, host.language()) });
    host.setMeta("research", JSON.stringify({ ...paused, budgetMessageId: m.id } satisfies ResearchState));
    await project.updateThread(threadId, { needs: "decision" }).catch((err) => console.warn("research needs", err));
    return;
  }
  if (progress.phase === "done") {
    await endResearch(host, current, { phase: state.stoppedBy ? "stopped" : state.interruptedAt ? "time" : "done", client });
    return;
  }
  await endResearch(host, current, { phase: "failed", reason: progress.detail ?? "failed", client });
}

/**
 * The research ended: what the researcher wrote last goes to the project files, the status line
 * says how it ended, and the thread wakes with the report (as text from outside the project).
 */
async function endResearch(
  host: ResearchHost,
  state: ResearchState,
  end: { phase: "done" | "time" | "budget" | "stopped" | "failed"; reason?: string; client?: ResearchClient },
): Promise<void> {
  host.deleteMeta("research");
  const language = host.language();
  const tr = language === "tr";
  const { projectId } = host.ids();
  const project = await getAgentByName(host.env.PROJECT_AGENT, projectId);
  const client = end.client ?? (await clientFor(host, state));
  const report = client && state.sessionId ? await researchReport(client, state.sessionId).catch((err) => (console.warn("research report", err), null)) : null;
  const spentCents = state.spentCents ?? 0;
  const partial =
    end.phase === "budget"
      ? tr
        ? "Araştırma bütçesinde bitirildi; rapor eksik olabilir."
        : "The research was finished at its budget; the report may be incomplete."
      : end.phase === "time"
        ? tr
          ? "Araştırma süre sınırında durduruldu; rapor eksik olabilir."
          : "The research was stopped at the time limit; the report may be incomplete."
        : end.phase === "stopped"
          ? tr
            ? `Araştırmayı ${state.stoppedBy ?? "bir kişi"} durdurdu; rapor eksik olabilir.`
            : `${state.stoppedBy ?? "Someone"} stopped the research; the report may be incomplete.`
        : end.phase === "failed"
          ? tr
            ? `Araştırma bitmedi (${end.reason ?? "bilinmiyor"}); bu, gelen son metin.`
            : `The research did not finish (${end.reason ?? "unknown"}); this is the last text it wrote.`
          : undefined;
  let path: string | null = null;
  if (report) {
    const at = new Date();
    path = researchPath(state.title, at, language);
    await project.writeFileText(path, researchFile(state, report, { spentCents, model: RESEARCH_MODEL, at, partial }, language), BY);
  }
  const endedAt = new Date().toISOString();
  await showCard(
    host,
    { ...state, status: "running" },
    end.phase === "failed" || !path
      ? { status: "failed", endedAt, note: end.reason ?? (tr ? "rapor gelmedi" : "no report came"), ...(path && { report: path }) }
      : {
          status: "done",
          endedAt,
          report: path,
          ...(report && { summary: reportSummary(report) }),
          ...(end.phase !== "done" && { partial: end.phase }),
        },
  );
  let wrapped: string | null = null;
  if (report && path) {
    const w = wrapExternal({ source: "claude-research", ref: path, trust: "untrusted" }, noteReport(report, path));
    if (w.taints) await host.markExternal("claude-research");
    wrapped = w.text;
  }
  await host.wake(
    researchNote(state, {
      spentCents,
      path,
      wrapped,
      reason: end.reason,
      ...(end.phase !== "done" &&
        end.phase !== "failed" && { partial: end.phase === "budget" ? "at its budget" : end.phase === "time" ? "at the time limit" : `${state.stoppedBy ?? "a person"} stopped it` }),
    }),
  );
}


/**
 * A person pressed Stop on the research's card. The person who approved it, the one the thread
 * works for, or a project owner or admin may stop it: a running research is interrupted and ends
 * with what it wrote so far; one paused at its budget ends at once. Returns why not, or null.
 */
export async function stopResearch(
  host: ResearchHost,
  input: { researchId: string; by: { id: string; name: string; admin: boolean } },
): Promise<string | null> {
  const state = readResearch(host);
  if (!state || state.id !== input.researchId || state.status === "asking") return "This research is not running.";
  const allowed = input.by.admin || input.by.id === state.approver || input.by.id === host.getMeta("requester");
  if (!allowed) return "Only the person who approved the research, the person the thread works for, or a project owner or admin can stop it.";
  if (state.stoppedBy) return null;
  const stopped: ResearchState = { ...state, stoppedBy: input.by.name };
  if (state.status === "budget") {
    await endResearch(host, stopped, { phase: "stopped" });
    return null;
  }
  const client = await clientFor(host, state);
  if (client && state.sessionId) {
    await interruptResearch(client, state.sessionId).catch((err) => console.warn("research stop", err));
  }
  host.setMeta("research", JSON.stringify({ ...stopped, interruptedAt: new Date().toISOString() } satisfies ResearchState));
  await showCard(host, stopped);
  // The interrupted turn goes idle within seconds; look then instead of at the next regular look.
  await host.schedule(5, { id: state.id });
  return null;
}
