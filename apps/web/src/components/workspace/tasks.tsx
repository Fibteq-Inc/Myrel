import type { Task, TerminalLine } from "@myrel/protocol";
import {
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
import type { Translate } from "@myrel/i18n";
import { useI18n, useT } from "@myrel/i18n/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
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

/** Every task, newest last. The running one opens by itself; finished ones stay folded. */
function TerminalTab({ projectId, tasks, output }: TaskData) {
  return (
    <div className="flex flex-col gap-3 p-4">
      {tasks.map((task) => (
        <TaskRow key={task.id} projectId={projectId} task={task} lines={output[task.id] ?? []} />
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

function TaskRow({ projectId, task, lines }: { projectId: string; task: Task; lines: TerminalLine[] }) {
  const t = useT();
  const running = task.status === "running";
  const [open, setOpen] = useState(running);
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
        </button>
        <span className="flex-none text-xs tabular-nums text-subtle" title={t("tasks.totalTime")}>
          {dur(Math.max(0, total))}
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
 * started, until the next tool call (or the end of the task).
 */
function stepTimes(lines: TerminalLine[], end: number): (number | undefined)[] {
  let next: number | undefined;
  const times: (number | undefined)[] = new Array(lines.length);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.ms !== undefined) times[i] = l.ms;
    else if (l.tool && l.at !== undefined) times[i] = Math.max(0, (next ?? end) - l.at);
    if (l.tool && l.at !== undefined) next = l.at;
  }
  return times;
}

function Terminal({ lines, end }: { lines: TerminalLine[]; end: number }) {
  const t = useT();
  const dur = useDuration();
  const times = stepTimes(lines, end);
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <pre
      ref={ref}
      role="log"
      aria-label={t("tasks.terminalOutput")}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="max-h-64 overflow-auto rounded-lg border border-line bg-[#08080a] px-3 py-2 font-mono text-[12px] leading-[1.55] text-body"
    >
      {lines.length === 0 && <span className="text-subtle">{t("tasks.waiting")}</span>}
      {lines.map((l, i) => (
        <div
          key={i}
          className={`flex items-start gap-3 ${l.stream === "stderr" ? "text-bad" : l.stream === "system" ? "text-subtle" : ""}`}
        >
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{l.text}</span>
          {times[i] !== undefined && (
            <span className="flex-none tabular-nums text-subtle" title={t("tasks.stepTime")}>
              {dur(times[i]!)}
            </span>
          )}
        </div>
      ))}
    </pre>
  );
}

function StatusIcon({ status }: { status: Task["status"] }) {
  const t = useT();
  if (status === "running") return <LoaderCircle size={14} className="flex-none animate-spin text-accent" aria-label={t("tasks.running")} />;
  if (status === "done") return <CircleCheck size={14} className="flex-none text-ok" aria-label={t("tasks.done")} />;
  if (status === "cancelled") return <CircleSlash size={14} className="flex-none text-subtle" aria-label={t("tasks.cancelled")} />;
  return <CircleAlert size={14} className="flex-none text-bad" aria-label={t("tasks.failed")} />;
}
