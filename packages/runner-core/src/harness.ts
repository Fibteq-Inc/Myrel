import { parseMarker } from "./lines";
import type { HarnessId, RunnerEvent, TaskSpec } from "./spec";

/**
 * A coding CLI the runner can start. Pure description: it says how to invoke
 * the CLI and how to read its output, so the cloud sandbox and the local
 * `myrel-runner` run the same harnesses the same way.
 *
 * The command runs under bash in the task's working directory with these
 * variables set: ALTAIR_PROMPT (the task prompt), plus whatever `env` returns
 * and the secrets the runner adds (ALTAIR_MODEL_API_KEY for the model).
 */
export interface Harness {
  readonly id: HarnessId;
  readonly label: string;
  /** Bash command line that runs the harness to completion. */
  command(spec: TaskSpec): string;
  /** Non-secret environment for the command. */
  env(spec: TaskSpec): Record<string, string>;
  /** Maps one line of the harness's output to events. */
  parse(line: string): RunnerEvent[];
}

/** Shared line handling: marker lines become their event, blank lines are dropped. */
export function parseLine(harness: Pick<Harness, "parse">, line: string): RunnerEvent[] {
  const marker = parseMarker(line);
  if (marker) return [marker];
  if (!line.trim()) return [];
  return harness.parse(line);
}

/** Parses a JSON object line, or returns null for anything else. */
export function jsonLine(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Normalizes a harness's todo status ("completed", "cancelled", ...) to ours. */
export function todoStatus(s: unknown): "pending" | "in_progress" | "done" {
  if (s === "in_progress") return "in_progress";
  if (s === "completed" || s === "done" || s === "cancelled") return "done";
  return "pending";
}

/** Single-quotes a string for bash. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export const log = (text: string, stream: "stdout" | "stderr" | "system" = "stdout"): RunnerEvent => ({
  type: "log",
  stream,
  text,
});
