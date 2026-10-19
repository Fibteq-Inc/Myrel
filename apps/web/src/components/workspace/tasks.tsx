import type { Task, TerminalLine } from "@altair/protocol";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  Square,
  SquareTerminal,
} from "lucide-react";
import { useT } from "@altair/i18n/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { EmptyTab, type WorkspaceTab } from "./workspace-panel";

type TaskData = { projectId: string; tasks: Task[]; output: Record<string, TerminalLine[]> };

/**
 * Fills the workspace's Terminal and Changes tabs with the tasks the thread
 * agent ran (run_task): live terminal output, and what each task changed.
 */
export function withTasks(tabs: WorkspaceTab[], data: TaskData): WorkspaceTab[] {
  if (data.tasks.length === 0) return tabs;
  const prs = data.tasks.filter((task) => task.prUrl).length;
  return tabs.map((tab) => {
    if (tab.id === "terminal") return { ...tab, count: data.tasks.length, content: <TerminalTab {...data} /> };
    if (tab.id === "changes") return { ...tab, count: prs || undefined, content: <ChangesTab tasks={data.tasks} /> };
    return tab;
  });
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
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

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
              try {
                await api.cancelTask(projectId, task.threadId, task.id);
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
      {open && <Terminal lines={lines} />}
    </div>
  );
}

function Terminal({ lines }: { lines: TerminalLine[] }) {
  const t = useT();
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
          className={`whitespace-pre-wrap break-words ${l.stream === "stderr" ? "text-bad" : l.stream === "system" ? "text-subtle" : ""}`}
        >
          {l.text}
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
