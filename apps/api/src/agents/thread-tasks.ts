import type { Task, TerminalLine } from "@altair/protocol";

export type TaskWithLog = Task & { log: TerminalLine[] };
