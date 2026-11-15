import type { FileRefContext } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, use, useMemo } from "react";
import { useProjectId } from "./project";
import { filesQueryKey, runnersQueryKey, workspaceQueryKey } from "./queries";
import { useSession } from "./session";

const FileRefs = createContext<FileRefContext | null>(null);

/**
 * What file paths in this project's messages can open, worked out once for the whole project. Every
 * message and every inline `path` in it reads it from here: asking the three queries for each of
 * them made a 60-message page hold some 900 query subscriptions, which stalled opening long threads.
 */
export function FileRefProvider({ children }: { children: ReactNode }) {
  const { api, server } = useSession();
  const projectId = useProjectId();
  const files = useQuery({ queryKey: filesQueryKey(server, projectId), queryFn: () => api.listFiles(projectId), staleTime: 30_000 });
  const workspace = useQuery({ queryKey: workspaceQueryKey(server, projectId), queryFn: () => api.getWorkspace(projectId) });
  const runners = useQuery({ queryKey: runnersQueryKey(server), queryFn: () => api.listRunners(), enabled: !!workspace.data });
  const runnerId = workspace.data?.runnerId;
  const mine = !!runnerId && !!runners.data?.some((r) => r.id === runnerId);
  const projectFiles = useMemo(() => new Set(files.data?.map((f) => f.path)), [files.data]);
  const value = useMemo<FileRefContext>(
    () => ({ projectFiles, workspace: runnerId ? (mine ? "mine" : "other") : null }),
    [projectFiles, runnerId, mine],
  );
  return <FileRefs value={value}>{children}</FileRefs>;
}

/** What file paths in this project's messages can open: its files, and its local folder if it has one. */
export function useFileRefContext(): FileRefContext {
  const value = use(FileRefs);
  if (!value) throw new Error("useFileRefContext outside FileRefProvider");
  return value;
}
