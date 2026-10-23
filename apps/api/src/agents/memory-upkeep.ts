import type { MemoryUpkeepMode } from "@myrel/protocol";

/** Threads that have to finish between two upkeep runs, and the shortest gap between them. */
export const UPKEEP_THREADS = 10;
export const UPKEEP_MIN_DAYS = 7;
/** Notes one upkeep run reads at most, so a large memory does not make one endless turn. */
export const UPKEEP_NOTE_LIMIT = 40;

export const UPKEEP_TITLE = "Memory upkeep";

/** Keys in the knowledge settings table. */
export const UPKEEP_KEYS = {
  mode: "memory_upkeep_mode",
  lastRunAt: "memory_upkeep_last_run_at",
  threadsSince: "memory_upkeep_threads_since",
  threadId: "memory_upkeep_thread_id",
} as const;

/**
 * Whether upkeep starts on its own. `auto` only where the project has a local folder whose tasks
 * run on someone's own CLI, so a project in the cloud never spends plan usage without being asked.
 */
export function upkeepActive(mode: MemoryUpkeepMode, runsLocally: boolean): boolean {
  return mode === "on" || (mode === "auto" && runsLocally);
}

/** Enough finished threads, and not too soon after the last run. */
export function upkeepDue(input: { threadsSince: number; lastRunAt: string | null; now: Date }): boolean {
  if (input.threadsSince < UPKEEP_THREADS) return false;
  if (!input.lastRunAt) return true;
  return input.now.getTime() - Date.parse(input.lastRunAt) >= UPKEEP_MIN_DAYS * 24 * 60 * 60 * 1000;
}

/** The project-chat line the upkeep thread opens under. */
export function upkeepNotice(threadsSince: number, manual: boolean): string {
  return manual
    ? "🧹 Memory upkeep: checking the project's memory against the project now."
    : `🧹 Memory upkeep: ${threadsSince} threads finished since memory was last checked, so Myrel is checking it against the project.`;
}

/** The thread agent's brief: what to check, what it may change on its own, and what goes to people. */
export function upkeepBrief(noteCount: number): string {
  const many = noteCount > UPKEEP_NOTE_LIMIT ? ` There are ${noteCount} notes: check the ${UPKEEP_NOTE_LIMIT} written longest ago this time, and say the rest wait for the next run.` : "";
  return `Memory upkeep for this project, started by Myrel (not by a person's ask). Keep the project memory true: notes are written once and go stale as the project moves on.${many}

1. Read each memory note (memory_read). Pick out what can be checked or depends on time: the state of pull requests and issues, versions, addresses, names, dates, "open", "pending" or "not done yet" items, decisions.
2. Check them against what this project has now: its connected GitHub repositories (pull requests, the default branch) if it has any, the project files, the instructions, and what people decided in recent threads. Do not guess: what you cannot check stays as it is.
3. Fix what is plainly out of date with memory_write: keep everything still true, write time-bound facts with their date. memory_mark ok the notes you checked and found right.
4. Mark stale with memory_mark, with the reason, what you think is wrong but cannot confirm, and what no longer applies. Two notes on the same subject: merge them into one with memory_write and mark the other stale with "merged into <name>". If MEMORY lists the other notes by name, move each key fact into that note's description and keep MEMORY for project-wide rules.
5. Do not delete anything on your own. If you marked notes stale, put one ask_decision card to the person (ask_person) asking whether to delete them, naming each one and why; delete only those they agree to.
6. Change nothing but memory: no code, files, pull requests or routines.
7. End with one short reply in the language people use in this project: what you fixed, what you marked and why. If nothing needed changing, say so in one line and resolve the thread.`;
}
