import type { Message, PromptSize } from "./models";

/** The prompt's parts in the order the context gauge lists them. */
export const PROMPT_PARTS = ["instructions", "knowledge", "brief", "conversation", "notes", "skills", "other"] as const;
export type PromptPart = (typeof PROMPT_PARTS)[number];

/** Past this share of its limit a thread's prompt reads as nearly full. */
export const PROMPT_NEAR_FULL = 0.8;

/**
 * How full a thread agent's prompt was: its share of the limit, and how loudly to say it. dropped:
 * the oldest messages or notes were left out (or one message cut), so the agent did not see them.
 */
export function promptGauge(size: PromptSize): { share: number; level: "ok" | "near" | "dropped" } {
  const share = size.limit ? Math.min(1, size.chars / size.limit) : 0;
  const dropped = size.droppedMessages > 0 || size.droppedNotes > 0 || size.cut;
  return { share, level: dropped ? "dropped" : share >= PROMPT_NEAR_FULL ? "near" : "ok" };
}

/** The prompt of the thread agent's latest turn, from the newest message that carries it. */
export function lastPromptSize(messages: readonly Message[]): PromptSize | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const prompt = messages[i]!.stats?.prompt;
    if (prompt) return prompt;
  }
  return null;
}
