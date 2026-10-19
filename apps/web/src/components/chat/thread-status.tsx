import { parseChecklist } from "@altair/client";
import type { Thread } from "@altair/protocol";
import { CircleAlert, CircleCheck, CircleDot, CirclePause, LoaderCircle } from "lucide-react";

type StatusKey = "working" | "blocked" | "review_ready" | "done" | "failed";

const STATUS: Record<StatusKey, { label: string; tone: string }> = {
  working: { label: "Working", tone: "text-subtle" },
  blocked: { label: "Checking with the coordinator", tone: "text-subtle" },
  review_ready: { label: "Waiting for you", tone: "text-warn" },
  done: { label: "Resolved", tone: "text-subtle" },
  failed: { label: "Failed", tone: "text-bad" },
};

function statusKey(thread: Thread): StatusKey {
  return thread.resolved ? "done" : thread.status;
}

/** The thread's state in a few words, plus the color class it reads in. */
export function threadStatus(thread: Thread) {
  return STATUS[statusKey(thread)];
}

/** What the thread is doing right now: its active checklist step, else its status. */
export function threadActivity(thread: Thread) {
  if (thread.status === "working" && !thread.resolved && thread.statusText) {
    const step = currentStep(thread.statusText);
    if (step) return { label: step, tone: "text-muted" };
  }
  return threadStatus(thread);
}

export function currentStep(statusText: string) {
  const { items } = parseChecklist(statusText);
  return items.find((i) => i.state === "active")?.text ?? null;
}

export function ThreadStatusIcon({ thread, size = 16 }: { thread: Thread; size?: number }) {
  const key = statusKey(thread);
  const props = { size, "aria-hidden": true, className: "flex-none" } as const;
  switch (key) {
    case "working":
      return <LoaderCircle {...props} className="flex-none animate-spin text-accent" />;
    case "blocked":
      return <CirclePause {...props} className="flex-none text-muted" />;
    case "review_ready":
      return <CircleDot {...props} className="flex-none text-warn" />;
    case "done":
      return <CircleCheck {...props} className="flex-none text-ok" />;
    case "failed":
      return <CircleAlert {...props} className="flex-none text-bad" />;
  }
}
