import type { Message } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

/**
 * The messages a thread's statistics are added up from: the ones held when they are all here, otherwise
 * the thread's replies with a stats line, fetched (again whenever the thread's usage moves). Null until
 * they are here.
 */
export function useThreadStatsMessages({
  projectId,
  threadId,
  messages,
  complete,
  version,
}: {
  projectId: string;
  threadId: string;
  messages: Message[];
  /** Every message of the thread is held. */
  complete: boolean;
  /** Changes when the thread's usage does. */
  version: string;
}): Message[] | null {
  const fetched = useQuery({
    queryKey: ["projects", projectId, "threads", threadId, "usage", version],
    queryFn: () => api.threadUsageMessages(projectId, threadId),
    enabled: !complete,
  });
  return complete ? messages : (fetched.data ?? null);
}
