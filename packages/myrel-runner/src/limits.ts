import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliId, CliLimits, CliLimitWindow } from "@myrel/protocol";
import { readJson, runnerHome, writeJson } from "./config";

/**
 * Subscription limits, read only from what the CLIs themselves print or write: Claude Code's
 * rate_limit_event in its stream-json output, and the rate limits Codex saves in its session
 * files. Myrel never reads a CLI's login or asks a provider's API.
 */

/** Claude Code's names for its windows, as Myrel shows them. */
const CLAUDE_WINDOWS: Record<string, string> = {
  five_hour: "session",
  seven_day: "weekly",
  seven_day_opus: "weekly_opus",
  seven_day_sonnet: "weekly_sonnet",
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const fromEpoch = (seconds: number | null) =>
  seconds !== null && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
const percent = (v: number | null) => (v === null ? null : Math.min(1000, Math.max(0, Math.round(v * 10) / 10)));

/**
 * Folds one rate_limit_info from Claude Code's rate_limit_event into what is known so far. The
 * event names the window that limits now; newer versions also carry every window (unifiedWindows).
 * Utilization is a fraction of the window.
 */
export function claudeLimits(info: unknown, prev?: CliLimits): CliLimits | undefined {
  if (!info || typeof info !== "object") return prev;
  const i = info as Record<string, unknown>;
  const windows = new Map((prev?.windows ?? []).map((w) => [w.kind, w]));
  const put = (name: unknown, utilization: unknown, resetsAt: unknown) => {
    const kind = typeof name === "string" ? CLAUDE_WINDOWS[name] : undefined;
    if (!kind) return;
    const used = num(utilization);
    const old = windows.get(kind);
    windows.set(kind, {
      kind,
      usedPercent: used === null ? (old?.usedPercent ?? null) : percent(used * 100),
      resetsAt: fromEpoch(num(resetsAt)) ?? old?.resetsAt ?? null,
    });
  };
  put(i.rateLimitType, i.utilization, i.resetsAt);
  if (i.unifiedWindows && typeof i.unifiedWindows === "object") {
    for (const [name, w] of Object.entries(i.unifiedWindows as Record<string, { utilization?: unknown; resetsAt?: unknown }>)) {
      if (w && typeof w === "object") put(name, w.utilization, w.resetsAt);
    }
  }
  const status = { allowed: "ok", allowed_warning: "warning", rejected: "limited" }[String(i.status)] as CliLimits["status"];
  if (!windows.size && !status) return prev;
  return { ...(status && { status }), windows: [...windows.values()].slice(0, 8), at: new Date().toISOString() };
}

/** Codex's windows by length: 5 hours and a week. */
function codexKind(minutes: number | null): string {
  if (minutes === 300) return "session";
  if (minutes === 10080) return "weekly";
  return minutes ? `${minutes}m` : "other";
}

/**
 * The rate_limits of one Codex token_count event: { primary, secondary }, each with used_percent,
 * window_minutes and resets_at (epoch seconds; older versions: resets_in_seconds from `at`).
 */
export function codexLimits(rateLimits: unknown, at: string): CliLimits | undefined {
  if (!rateLimits || typeof rateLimits !== "object") return undefined;
  const windows: CliLimitWindow[] = [];
  for (const key of ["primary", "secondary"]) {
    const w = (rateLimits as Record<string, unknown>)[key] as Record<string, unknown> | null | undefined;
    if (!w || typeof w !== "object") continue;
    const resetsIn = num(w.resets_in_seconds);
    const resetsAt =
      fromEpoch(num(w.resets_at)) ??
      (resetsIn !== null ? new Date(new Date(at).getTime() + resetsIn * 1000).toISOString() : null);
    windows.push({ kind: codexKind(num(w.window_minutes)), usedPercent: percent(num(w.used_percent)), resetsAt });
  }
  if (!windows.length) return undefined;
  const limited = windows.some((w) => (w.usedPercent ?? 0) >= 100 && (!w.resetsAt || w.resetsAt > new Date().toISOString()));
  return { status: limited ? "limited" : "ok", windows, at };
}

/** $CODEX_HOME, or ~/.codex. */
function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

/** Names in a folder, newest-sounding first (Codex names folders and files by date). */
async function newestFirst(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.sort().reverse();
}

/** How much of a session file's end is read for its last token_count. */
const TAIL_BYTES = 256 * 1024;

/** The limits in the last token_count event of one Codex session file. */
async function limitsInFile(path: string): Promise<CliLimits | undefined> {
  const file = await open(path, "r").catch(() => null);
  if (!file) return undefined;
  try {
    const { size } = await file.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      if (!line.includes('"rate_limits"')) continue;
      try {
        const entry = JSON.parse(line) as { timestamp?: unknown; payload?: { type?: unknown; rate_limits?: unknown } };
        if (entry.payload?.type !== "token_count") continue;
        const at = typeof entry.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp))
          ? new Date(entry.timestamp).toISOString()
          : (await stat(path)).mtime.toISOString();
        const limits = codexLimits(entry.payload.rate_limits, at);
        if (limits) return limits;
      } catch {
        // A line cut at the start of the tail, or one Codex was still writing.
      }
    }
    return undefined;
  } finally {
    await file.close();
  }
}

/**
 * Codex's latest limits from its session files ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl):
 * from the session `sessionId` when given, otherwise from the newest sessions, which includes
 * the person's own use of Codex outside Myrel.
 */
export async function readCodexLimits(sessionId?: string): Promise<CliLimits | undefined> {
  const root = join(codexHome(), "sessions");
  let checked = 0;
  for (const year of await newestFirst(root)) {
    for (const month of await newestFirst(join(root, year))) {
      for (const day of await newestFirst(join(root, year, month))) {
        const dir = join(root, year, month, day);
        for (const name of await newestFirst(dir)) {
          if (!name.endsWith(".jsonl")) continue;
          if (sessionId && !name.includes(sessionId)) continue;
          const limits = await limitsInFile(join(dir, name));
          if (limits || sessionId) return limits;
          // Sessions with no model call yet carry no limits; a few older ones may.
          if (++checked >= 20) return undefined;
        }
        if (sessionId && ++checked >= 14) return undefined;
      }
    }
  }
  return undefined;
}

const limitsPath = () => join(runnerHome(), "limits.json");

/** The last limits each CLI reported, kept across restarts so the web app still shows them. */
export async function loadLimits(): Promise<Partial<Record<CliId, CliLimits>>> {
  return (await readJson<Partial<Record<CliId, CliLimits>>>(limitsPath()).catch(() => undefined)) ?? {};
}

export async function saveLimits(limits: Partial<Record<CliId, CliLimits>>): Promise<void> {
  await writeJson(limitsPath(), limits);
}
