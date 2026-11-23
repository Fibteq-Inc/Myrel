import type { Message, MessageStats } from "./models";
import { messageUsage } from "./thread-summary";

/** What some of a thread's work adds up to. Model time covers only the turns where it was measured. */
export type WorkStats = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  durationMs: number;
  waitMs: number;
  /** Null when any part has no price; a person's own CLI counts as free. */
  costMicros: number | null;
  turns: number;
  modelMs: number;
  modelOutputTokens: number;
  /** How long the measured turns took in all. */
  measuredMs: number;
  measuredWaitMs: number;
};

export type WorkGroup = WorkStats & { key: string; harness: string | null; model: string; computer: string | null; runtime: MessageStats["runtime"] };

type WithStats = Pick<Message, "id"> & { stats?: MessageStats };

const empty = (): WorkStats => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  durationMs: 0,
  waitMs: 0,
  costMicros: 0,
  turns: 0,
  modelMs: 0,
  modelOutputTokens: 0,
  measuredMs: 0,
  measuredWaitMs: 0,
});

function add(sum: WorkStats, st: MessageStats, measured: boolean): void {
  const u = messageUsage(st);
  sum.inputTokens += u.inputTokens;
  sum.outputTokens += u.outputTokens;
  sum.cachedInputTokens += st.cachedInputTokens;
  sum.durationMs += u.durationMs;
  sum.waitMs += st.waitMs ?? 0;
  sum.costMicros = sum.costMicros === null || u.costMicros === null ? null : sum.costMicros + u.costMicros;
  sum.modelMs += st.modelMs ?? 0;
  if (!measured) return;
  sum.modelOutputTokens += u.outputTokens;
  sum.measuredMs += u.durationMs;
  sum.measuredWaitMs += st.waitMs ?? 0;
}

/**
 * A thread's statistics from the stats lines under its messages, oldest first: all of it, its last
 * turn, and by CLI, model and computer. A CLI reports its model time once, at the turn's end, so it
 * sits on one message: the turn's other messages count as measured with it.
 */
export function threadWork(messages: readonly WithStats[]): { total: WorkStats; last: WorkStats | null; groups: WorkGroup[] } {
  const lines = messages.filter((m): m is WithStats & { stats: MessageStats } => !!m.stats);
  const measured = new Set(lines.filter((m) => m.stats.modelMs && m.stats.turn).map((m) => m.stats.turn));
  // A message from before turns were named is counted as one of its own.
  const turnOf = (m: (typeof lines)[number]) => m.stats.turn ?? m.id;
  const isMeasured = (m: (typeof lines)[number]) => !!m.stats.turn && measured.has(m.stats.turn);
  const total = empty();
  const groups = new Map<string, WorkGroup>();
  const seen = new Set<string>();
  // A CLI may name its model only after its first message, so a turn belongs where its last line does.
  const lastOf = new Map(lines.map((m) => [turnOf(m), m.stats]));
  for (const m of lines) {
    const st = lastOf.get(turnOf(m))!;
    const harness = st.task?.harness ?? st.harness ?? null;
    const model = st.task?.model ?? st.model;
    const key = `${st.runtime}/${st.computer ?? ""}/${harness ?? ""}/${model}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { ...empty(), key, harness, model, computer: st.computer ?? null, runtime: st.runtime }));
    add(total, m.stats, isMeasured(m));
    add(group, m.stats, isMeasured(m));
    const turn = turnOf(m);
    if (!seen.has(turn)) {
      seen.add(turn);
      total.turns++;
      group.turns++;
    }
  }
  const newest = lines.at(-1);
  let last: WorkStats | null = null;
  if (newest) {
    last = { ...empty(), turns: 1 };
    for (const m of lines) if (turnOf(m) === turnOf(newest)) add(last, m.stats, isMeasured(m));
  }
  return { total, last, groups: [...groups.values()] };
}

/**
 * Where the measured turns' time went: the model, waiting for a person, and everything else (mostly
 * commands). Null when no turn was measured. Model calls that ran side by side can add up to more
 * than the clock, and then nothing is left over.
 */
export function timeSplit(w: WorkStats): { modelMs: number; waitMs: number; restMs: number } | null {
  if (!w.modelMs || !w.measuredMs) return null;
  return { modelMs: w.modelMs, waitMs: w.measuredWaitMs, restMs: Math.max(0, w.measuredMs - w.modelMs - w.measuredWaitMs) };
}
