import type { Message, MessageStats, ThreadSummary } from "./models";
import { isPlanMessage, planChecklist } from "./plan";

/** What one message's stats line counts, its task included. Cost is null when any part has no price. */
export function messageUsage(st: MessageStats): { inputTokens: number; outputTokens: number; durationMs: number; costMicros: number | null } {
  const { task } = st;
  return {
    inputTokens: st.inputTokens + (task?.inputTokens ?? 0),
    outputTokens: st.outputTokens + (task?.outputTokens ?? 0),
    durationMs: st.durationMs + (task?.durationMs ?? 0),
    // A person's own CLI is unpriced on purpose; it counts as free rather than unknown.
    costMicros:
      st.runtime === "local" && st.harness
        ? 0
        : st.costMicros === null || task?.costMicros === null
          ? null
          : st.costMicros + (task?.costMicros ?? 0),
  };
}

/**
 * What a thread's messages add up to, oldest first: the server keeps it on the thread, and clients
 * fall back to it for a thread from an older server.
 */
export function summarizeThread(messages: Iterable<Pick<Message, "id" | "authorKind" | "body" | "stats">>): ThreadSummary {
  const summary: ThreadSummary = { replies: 0, usage: null, planMessageId: null };
  for (const m of messages) {
    if (!isPlanMessage(m.body)) summary.replies++;
    if (m.authorKind === "agent" && planChecklist(m.body) !== null) summary.planMessageId = m.id;
    if (!m.stats) continue;
    const u = messageUsage(m.stats);
    const total = (summary.usage ??= { tokens: 0, durationMs: 0, costMicros: 0 });
    total.tokens += u.inputTokens + u.outputTokens;
    total.durationMs += u.durationMs;
    total.costMicros = total.costMicros === null || u.costMicros === null ? null : total.costMicros + u.costMicros;
  }
  return summary;
}
