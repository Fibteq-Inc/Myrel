import { type Task, type TerminalLine, unwrapShell } from "@myrel/protocol";
import {
  Bot,
  ChevronRight,
  CircleAlert,
  FolderTree,
  CircleCheck,
  CircleSlash,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  Square,
  SquareTerminal,
} from "lucide-react";
import { newestFirst, taskHeadline } from "@myrel/client";
import { clockTime, dayLabel, localDay, type Translate } from "@myrel/i18n";
import { useI18n, useT } from "@myrel/i18n/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useFormat } from "../../lib/format";
import { duration } from "../chat/message-stats";
import { FilesTab } from "./files";
import { EmptyTab, type WorkspaceTab } from "./workspace-panel";

type TaskData = { projectId: string; threadId: string; tasks: Task[]; output: Record<string, TerminalLine[]> };

/**
 * Fills the workspace's Terminal and Changes tabs with the tasks the thread
 * agent ran (one per turn): live terminal output, and what each run changed.
 */
export function withTasks(tabs: WorkspaceTab[], data: TaskData, t: Translate): WorkspaceTab[] {
  if (data.tasks.length === 0) return tabs;
  const prs = data.tasks.filter((task) => task.prUrl).length;
  const filled = tabs.map((tab) => {
    if (tab.id === "terminal") return { ...tab, count: data.tasks.length, content: <TerminalTab {...data} /> };
    if (tab.id === "changes") return { ...tab, count: prs || undefined, content: <ChangesTab tasks={data.tasks} /> };
    return tab;
  });
  // Cloud tasks save their work in the thread's workspace; tasks on a computer work in its own folder.
  if (!data.tasks.some((task) => task.backend === "sandbox")) return filled;
  const files: WorkspaceTab = {
    id: "files",
    label: t("files.workspace"),
    icon: FolderTree,
    content: <FilesTab projectId={data.projectId} threadId={data.threadId} tasks={data.tasks} />,
  };
  return [...filled.slice(0, 2), files, ...filled.slice(2)];
}

/**
 * Every task, newest first under a heading for its day. The running one and, once all are done, the
 * latest open by themselves; the rest stay folded.
 */
function TerminalTab({ projectId, tasks, output }: TaskData) {
  const { t, locale } = useI18n();
  const sorted = newestFirst(tasks);
  const days: { day: string; tasks: Task[] }[] = [];
  for (const task of sorted) {
    const day = localDay(task.createdAt);
    if (days.at(-1)?.day === day) days.at(-1)!.tasks.push(task);
    else days.push({ day, tasks: [task] });
  }
  return (
    <div className="flex flex-col gap-3 p-4">
      {days.map(({ day, tasks: dayTasks }, i) => (
        <section key={day} className={`flex flex-col gap-3 ${i > 0 ? "mt-2" : ""}`}>
          <h3 className="text-xs font-medium text-subtle">{dayLabel(t, locale, dayTasks[0]!.createdAt)}</h3>
          {dayTasks.map((task) => (
            <TaskRow key={task.id} projectId={projectId} task={task} lines={output[task.id] ?? []} latest={task.id === sorted[0]!.id} />
          ))}
        </section>
      ))}
    </div>
  );
}

function ChangesTab({ tasks }: { tasks: Task[] }) {
  const t = useT();
  const finished = tasks.filter((task) => task.status !== "running");
  if (finished.length === 0) {
    return (
      <EmptyTab icon={GitPullRequest} title={t("tasks.inProgressTitle")}>
        {t("tasks.inProgressBody")}
      </EmptyTab>
    );
  }
  return (
    <ul className="flex flex-col gap-3 p-4">
      {[...finished].reverse().map((task) => (
        <li key={task.id} className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3.5">
          <div className="flex items-center gap-2 text-[13px]">
            <StatusIcon status={task.status} />
            <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noreferrer"
                className="flex flex-none items-center gap-1 rounded-md px-2 py-1 text-xs text-accent hover:bg-hover"
              >
                <GitPullRequest size={12} aria-hidden="true" />
                {t("tasks.pullRequest")}
                <ExternalLink size={11} aria-hidden="true" />
              </a>
            )}
          </div>
          {task.summary && <p className="line-clamp-6 whitespace-pre-wrap text-[13px] text-muted">{task.summary}</p>}
        </li>
      ))}
    </ul>
  );
}

function TaskRow({ projectId, task, lines, latest }: { projectId: string; task: Task; lines: TerminalLine[]; latest: boolean }) {
  const { t, locale } = useI18n();
  const format = useFormat();
  const running = task.status === "running";
  const [open, setOpen] = useState(running || latest);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const now = useNow(running);
  const dur = useDuration();
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  const started = Date.parse(task.createdAt);
  const total = (task.finishedAt ? Date.parse(task.finishedAt) : now) - started;
  const lastAt = lines.findLast((l) => l.at !== undefined)?.at ?? started;
  const quietMs = running ? now - lastAt : 0;
  const headline = taskHeadline(task.summary);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[13px]">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left hover:text-fg"
        >
          <ChevronRight size={14} className={`flex-none text-subtle transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />
          <StatusIcon status={task.status} />
          <SquareTerminal size={14} className="flex-none text-subtle" aria-hidden="true" />
          <span className="truncate font-medium">{task.title}</span>
          <span className="flex-none text-xs text-subtle">{task.harness}</span>
          {headline && <span className="min-w-0 flex-1 truncate text-xs text-muted">{headline}</span>}
        </button>
        <span className="flex flex-none items-center gap-1.5 text-xs tabular-nums text-subtle">
          <time dateTime={task.createdAt} title={t("tasks.startedAt", { time: `${format.dateTime(task.createdAt)} · ${format.relative(task.createdAt)}` })}>
            {clockTime(locale, task.createdAt)}
          </time>
          <span aria-hidden="true">·</span>
          <span title={t("tasks.totalTime")}>{dur(Math.max(0, total))}</span>
        </span>
        {task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            className="flex flex-none items-center gap-1 rounded-md px-2 py-1 text-xs text-accent hover:bg-hover"
          >
            {t("tasks.pullRequest")}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
        {running && (
          <button
            type="button"
            disabled={stopping}
            onClick={async () => {
              setStopping(true);
              setStopError(null);
              try {
                await api.cancelTask(projectId, task.threadId, task.id);
              } catch (err) {
                setStopError(err instanceof Error ? err.message : t("tasks.stopFailed"));
              } finally {
                setStopping(false);
              }
            }}
            className="flex flex-none items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg disabled:opacity-50"
          >
            <Square size={11} aria-hidden="true" />
            {t("tasks.stop")}
          </button>
        )}
      </div>
      {stopError && running && <p className="pl-6 text-xs text-bad">{stopError}</p>}
      {open && <Terminal lines={lines} end={task.finishedAt ? Date.parse(task.finishedAt) : now} />}
      {quietMs > QUIET_MS && <p className="pl-6 text-xs text-muted">{t("tasks.quiet", { time: dur(quietMs) })}</p>}
    </div>
  );
}

/** Past this long without a new line, a running task says it may be stuck. */
const QUIET_MS = 3 * 60_000;

/** The current time, ticking every second while `live`. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

function useDuration() {
  const t = useT();
  const { locale } = useI18n();
  return (ms: number) => duration(ms, t, locale);
}

/**
 * How long each line's step took: what the runner reported, or for a tool call reported when it
 * started, until the next tool call of the same agent (subagents run alongside it) or the end of the task.
 */
function stepTimes(lines: TerminalLine[], end: number): (number | undefined)[] {
  const next = new Map<string, number>();
  const times: (number | undefined)[] = new Array(lines.length);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    const who = l.agent?.id ?? "";
    if (l.ms !== undefined) times[i] = l.ms;
    else if (l.tool && l.at !== undefined) times[i] = Math.max(0, (next.get(who) ?? end) - l.at);
    if (l.tool && l.at !== undefined) next.set(who, l.at);
  }
  return times;
}

function Terminal({ lines, end }: { lines: TerminalLine[]; end: number }) {
  const t = useT();
  const dur = useDuration();
  const times = stepTimes(lines, end);
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <div
      ref={ref}
      role="log"
      aria-label={t("tasks.terminalOutput")}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="flex max-h-[28rem] flex-col overflow-auto rounded-lg border border-line bg-console px-3 py-2 font-mono text-[12px] leading-[1.6] text-body"
    >
      {lines.length === 0 && <span className="text-subtle">{t("tasks.waiting")}</span>}
      {lines.map((l, i) => (
        <TerminalRow key={i} line={l} first={i === 0} time={times[i] === undefined ? undefined : dur(times[i]!)} />
      ))}
    </div>
  );
}

/** Past this many characters or lines, a step shows folded with a toggle. */
const FOLD_CHARS = 280;
const FOLD_LINES = 3;

/**
 * One terminal line. A command shows after a prompt, without the shell wrapper the CLI ran it in;
 * an agent's step or message reads as prose; output stays monospace under its command. The step's
 * time has its own column, so long text wraps beside it instead of running into it.
 */
function TerminalRow({ line, first, time }: { line: TerminalLine; first: boolean; time?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (line.agent?.state) return <AgentRow line={line} first={first} time={time} />;
  const agent = line.agent;
  const step = line.tool ? line.text.replace(/^→ /, "") : null;
  const command = step?.startsWith("$ ") ? unwrapShell(step.slice(2)) : null;
  const text = command ?? step ?? line.text;
  const long = !!step && (text.length > FOLD_CHARS || text.split("\n").length > FOLD_LINES);
  const folded = long && !open;
  const tone = line.stream === "stderr" ? "text-bad" : step ? "" : line.stream === "system" ? "text-subtle" : "text-muted";
  return (
    <div
      className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 ${step && !first ? "mt-2" : ""} ${agent ? "ml-1.5 border-l border-line pl-3" : ""} ${tone}`}
      title={agent ? t("tasks.agentStep", { name: agent.label }) : undefined}
    >
      <span aria-hidden="true" className={`w-[1ch] select-none ${command ? "text-accent" : step ? "text-subtle" : ""}`}>
        {command ? "$" : step ? "›" : ""}
      </span>
      <div className="min-w-0">
        {agent && step && <div className="font-sans text-[11px] leading-[1.4] text-accent">{agent.label}</div>}
        <div
          className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${step && !command ? "font-sans text-[13px] leading-[1.5] text-fg" : ""} ${command ? "text-fg" : ""} ${folded ? "line-clamp-3" : ""}`}
        >
          {text}
        </div>
        {long && (
          <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 font-sans text-xs text-accent hover:underline">
            {open ? t("tasks.showLess") : t("tasks.showMore")}
          </button>
        )}
      </div>
      <span className="whitespace-nowrap pl-2 text-right tabular-nums text-subtle" title={time ? t("tasks.stepTime") : undefined}>
        {time ?? ""}
      </span>
    </div>
  );
}

/** A subagent starting (with what it is for) or ending (with its answer, folded when long). */
function AgentRow({ line, first, time }: { line: TerminalLine; first: boolean; time?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const agent = line.agent!;
  const key = agent.state === "started" ? "tasks.agentStarted" : agent.state === "done" ? "tasks.agentDone" : "tasks.agentFailed";
  const text = line.text.trim();
  const long = text.length > FOLD_CHARS || text.split("\n").length > FOLD_LINES;
  const tone = agent.state === "failed" ? "text-bad" : agent.state === "done" ? "text-ok" : "text-accent";
  return (
    <div className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 ${first ? "" : "mt-2"}`}>
      <Bot size={13} aria-hidden="true" className={`mt-[3px] flex-none ${tone}`} />
      <div className="min-w-0 font-sans text-[13px] leading-[1.5]">
        <div className={`font-medium ${agent.state === "failed" ? "text-bad" : "text-fg"}`}>{t(key, { name: agent.label })}</div>
        {text && <div className={`whitespace-pre-wrap text-muted [overflow-wrap:anywhere] ${long && !open ? "line-clamp-3" : ""}`}>{text}</div>}
        {long && (
          <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 text-xs text-accent hover:underline">
            {open ? t("tasks.showLess") : t("tasks.showMore")}
          </button>
        )}
      </div>
      <span className="whitespace-nowrap pl-2 text-right tabular-nums text-subtle" title={time ? t("tasks.stepTime") : undefined}>
        {time ?? ""}
      </span>
    </div>
  );
}

function StatusIcon({ status }: { status: Task["status"] }) {
  const t = useT();
  if (status === "running") return <LoaderCircle size={14} className="flex-none animate-spin text-accent" aria-label={t("tasks.running")} />;
  if (status === "done") return <CircleCheck size={14} className="flex-none text-ok" aria-label={t("tasks.done")} />;
  if (status === "cancelled") return <CircleSlash size={14} className="flex-none text-subtle" aria-label={t("tasks.cancelled")} />;
  return <CircleAlert size={14} className="flex-none text-bad" aria-label={t("tasks.failed")} />;
}
