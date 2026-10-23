import type { Message, Thread } from "./models";

/**
 * A person's message in a thread whose agent is mid-turn and has not taken it in yet: clients show
 * it as waiting, with a way to interrupt the turn so it goes now. False when the server does not say
 * what the agent has seen (seenSeq null).
 */
export function waitsForAgent(
  message: Pick<Message, "authorKind" | "seq" | "threadId">,
  thread: Pick<Thread, "id" | "status" | "resolved" | "seenSeq">,
): boolean {
  return (
    message.threadId === thread.id &&
    message.authorKind === "user" &&
    thread.status === "working" &&
    !thread.resolved &&
    thread.seenSeq !== null &&
    message.seq > thread.seenSeq
  );
}
