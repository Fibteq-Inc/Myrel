import { parseChecklist } from "@altair/client";
import type { Thread } from "@altair/protocol";
import { CircleAlert, CircleCheck, CircleDot, CirclePause } from "lucide-react-native";
import { colors } from "../theme";
import { Spinner } from "./ui";

type StatusKey = "working" | "blocked" | "review_ready" | "done" | "failed";

const STATUS: Record<StatusKey, { label: string; color: string }> = {
  working: { label: "Working", color: colors.subtle },
  blocked: { label: "Checking with the coordinator", color: colors.subtle },
  review_ready: { label: "Waiting for you", color: colors.warn },
  done: { label: "Resolved", color: colors.subtle },
  failed: { label: "Failed", color: colors.bad },
};

function statusKey(thread: Thread): StatusKey {
  return thread.resolved ? "done" : thread.status;
}

/** The thread's state in a few words, plus the color it reads in. */
export function threadStatus(thread: Thread) {
  return STATUS[statusKey(thread)];
}

/** What the thread is doing right now: its active checklist step, else its status. */
export function threadActivity(thread: Thread) {
  if (thread.status === "working" && !thread.resolved && thread.statusText) {
    const step = parseChecklist(thread.statusText).items.find((i) => i.state === "active")?.text;
    if (step) return { label: step, color: colors.muted };
  }
  return threadStatus(thread);
}

export function ThreadStatusIcon({ thread, size = 16 }: { thread: Thread; size?: number }) {
  switch (statusKey(thread)) {
    case "working":
      return <Spinner size={size} />;
    case "blocked":
      return <CirclePause size={size} color={colors.muted} />;
    case "review_ready":
      return <CircleDot size={size} color={colors.warn} />;
    case "done":
      return <CircleCheck size={size} color={colors.ok} />;
    case "failed":
      return <CircleAlert size={size} color={colors.bad} />;
  }
}
