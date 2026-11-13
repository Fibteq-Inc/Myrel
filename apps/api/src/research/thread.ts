import { createDb, schema } from "@myrel/db";
import { createId, type Message } from "@myrel/protocol";
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
  type ResearchLine,
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
  researchStatusLine,
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
  const m = await project.sendMessage({
    threadId,
    authorKind: "system",
    authorId: SYSTEM_ID,
    body: researchStatusLine(running, { kind: "running", spentCents: 0 }, language),
  });
  host.setMeta("research", JSON.stringify({ ...running, statusMessageId: m.id } satisfies ResearchState));
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
  await editLine(host, running, { kind: "running", spentCents: state.spentCents ?? 0 });
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

async function editLine(host: ResearchHost, state: ResearchState, line: ResearchLine): Promise<void> {
  if (!state.statusMessageId) return;
  const project = await getAgentByName(host.env.PROJECT_AGENT, host.ids().projectId);
  await project.editMessage(state.statusMessageId, researchStatusLine(state, line, host.language())).catch((err) => console.warn("research line not edited", err));
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
    let next = state;
    if (ranSec > RESEARCH_MAX_RUN_SEC && !state.interruptedAt) {
      await interruptResearch(client, state.sessionId).catch((err) => console.warn("research interrupt", err));
      next = { ...next, interruptedAt: new Date(now).toISOString() };
    }
    if (progress.spentCents !== state.spentCents) {
      next = { ...next, spentCents: progress.spentCents };
      await editLine(host, next, { kind: "running", spentCents: progress.spentCents });
    }
    if (next !== state) host.setMeta("research", JSON.stringify(next));
    await host.schedule(nextPollSec(state.startedAt, now), { id: state.id });
    return;
  }
  const current = { ...state, spentCents: progress.spentCents };
  if (progress.phase === "budget") {
    const { projectId, threadId } = host.ids();
    const project = await getAgentByName(host.env.PROJECT_AGENT, projectId);
    await editLine(host, current, { kind: "budget", spentCents: progress.spentCents });
    const m = await project.sendMessage({ threadId, authorKind: "agent", authorId: THREAD_AGENT_ID, body: researchBudgetMessage(current, host.language()) });
    host.setMeta("research", JSON.stringify({ ...current, status: "budget", budgetMessageId: m.id } satisfies ResearchState));
    await project.updateThread(threadId, { needs: "decision" }).catch((err) => console.warn("research needs", err));
    return;
  }
  if (progress.phase === "done") {
    await endResearch(host, current, { phase: state.interruptedAt ? "time" : "done", client });
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
  end: { phase: "done" | "time" | "budget" | "failed"; reason?: string; client?: ResearchClient },
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
  const line: ResearchLine =
    end.phase === "failed" || !path
      ? { kind: "failed", spentCents, reason: end.reason ?? (tr ? "rapor gelmedi" : "no report came"), ...(path && { path }) }
      : { kind: "done", spentCents, path, ...(end.phase !== "done" && { partial: end.phase }) };
  await editLine(host, state, line);
  let wrapped: string | null = null;
  if (report && path) {
    const w = wrapExternal({ source: "claude-research", ref: path, trust: "untrusted" }, noteReport(report, path));
    if (w.taints) await host.markExternal("claude-research");
    wrapped = w.text;
  }
  await host.wake(
    researchNote(state, { spentCents, path, wrapped, reason: end.reason, ...(end.phase !== "done" && end.phase !== "failed" && { partial: end.phase === "budget" ? "at its budget" : "at the time limit" }) }),
  );
}

