import { parseChecklist } from "@myrel/client";
import type { MessageKey } from "@myrel/i18n";
import type { Thread, ThreadCloseReason } from "@myrel/protocol";
import { CircleAlert, CircleCheck, CircleDot, CircleMinus, CirclePause } from "lucide-react-native";
import { type Colors, useColors } from "../theme";
import { Spinner } from "./ui";

type StatusKey = "working" | "blocked" | "review_ready" | "done" | "failed" | "closed";

const STATUS: Record<StatusKey, { label: MessageKey; color: keyof Colors }> = {
  working: { label: "status.working", color: "subtle" },
  blocked: { label: "status.blocked", color: "subtle" },
  review_ready: { label: "status.reviewReady", color: "warn" },
  done: { label: "status.done", color: "subtle" },
  failed: { label: "status.failed", color: "bad" },
  closed: { label: "status.closedCancelled", color: "subtle" },
};

/** A thread closed as opened by mistake says why. */
const CLOSED: Record<ThreadCloseReason, MessageKey> = {
  duplicate: "status.closedDuplicate",
  misrouted: "status.closedMisrouted",
  cancelled: "status.closedCancelled",
};

function statusKey(thread: Thread): StatusKey {
  return thread.closeReason ? "closed" : thread.resolved ? "done" : thread.status;
}

type Translate = (key: MessageKey) => string;

/** The thread's state in a few words, plus the color it reads in. */
export function threadStatus(thread: Thread, t: Translate, colors: Colors) {
  const s = STATUS[statusKey(thread)];
  return { label: t(thread.closeReason ? CLOSED[thread.closeReason] : s.label), color: colors[s.color] };
}

/** What the thread is doing right now: its active checklist step, else its status. */
export function threadActivity(thread: Thread, t: Translate, colors: Colors) {
  if (thread.status === "working" && !thread.resolved && thread.statusText) {
    const step = parseChecklist(thread.statusText).items.find((i) => i.state === "active")?.text;
    if (step) return { label: step, color: colors.muted };
  }
  return threadStatus(thread, t, colors);
}

export function ThreadStatusIcon({ thread, size = 16 }: { thread: Thread; size?: number }) {
  const colors = useColors();
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
    case "closed":
      return <CircleMinus size={size} color={colors.subtle} />;
  }
}
