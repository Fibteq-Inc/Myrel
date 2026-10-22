import type { FileRefContext } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useProject } from "./project";
import { filesQueryKey } from "./queries";
import { useSession } from "./session";

/** What file paths in this project's messages can open: its files, and its local folder if it has one. */
export function useFileRefContext(): FileRefContext {
  const { api, server } = useSession();
  const { projectId } = useProject();
  const files = useQuery({ queryKey: filesQueryKey(server, projectId), queryFn: () => api.listFiles(projectId), staleTime: 30_000 });
  const workspace = useQuery({ queryKey: ["workspace", server, projectId], queryFn: () => api.getWorkspace(projectId) });
  const runners = useQuery({ queryKey: ["runners", server], queryFn: () => api.listRunners(), enabled: !!workspace.data });
  const runnerId = workspace.data?.runnerId;
  const mine = !!runnerId && !!runners.data?.some((r) => r.id === runnerId);
  const projectFiles = useMemo(() => new Set(files.data?.map((f) => f.path)), [files.data]);
  return useMemo(() => ({ projectFiles, workspace: runnerId ? (mine ? "mine" : "other") : null }), [projectFiles, runnerId, mine]);
}
