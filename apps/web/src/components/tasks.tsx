import type { Task, TerminalLine } from "@altair/protocol";
import { ChevronRight, CircleAlert, CircleCheck, CircleSlash, ExternalLink, LoaderCircle, Square, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

/**
 * The tasks a thread agent ran in its sandbox (run_task), each with its live
 * terminal output. The running task opens by itself; finished ones stay folded.
 */
export function TaskPanel({
  projectId,
  tasks,
  output,
}: {
  projectId: string;
  tasks: Task[];
  output: Record<string, TerminalLine[]>;
}) {
  if (tasks.length === 0) return null;
  return (
    <div className="flex flex-none flex-col gap-2 border-b border-line bg-panel px-5 py-3">
      {tasks.map((t) => (
        <TaskRow key={t.id} projectId={projectId} task={t} lines={output[t.id] ?? []} />
      ))}
    </div>
  );
}

function TaskRow({ projectId, task, lines }: { projectId: string; task: Task; lines: TerminalLine[] }) {
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
            Pull request
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
            Stop
          </button>
        )}
      </div>
      {open && <Terminal lines={lines} />}
    </div>
  );
}

function Terminal({ lines }: { lines: TerminalLine[] }) {
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
      aria-label="Terminal output"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="max-h-64 overflow-auto rounded-lg border border-line bg-[#08080a] px-3 py-2 font-mono text-[12px] leading-[1.55] text-body"
    >
      {lines.length === 0 && <span className="text-subtle">Waiting for output…</span>}
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
  if (status === "running") return <LoaderCircle size={14} className="flex-none animate-spin text-accent" aria-label="Running" />;
  if (status === "done") return <CircleCheck size={14} className="flex-none text-ok" aria-label="Done" />;
  if (status === "cancelled") return <CircleSlash size={14} className="flex-none text-subtle" aria-label="Cancelled" />;
  return <CircleAlert size={14} className="flex-none text-bad" aria-label="Failed" />;
}
