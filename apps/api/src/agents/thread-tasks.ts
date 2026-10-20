import type { Task, TerminalLine } from "@myrel/protocol";

export type TaskWithLog = Task & { log: TerminalLine[] };
