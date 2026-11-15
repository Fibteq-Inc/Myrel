import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Names } from "../components/message";
import { useSession } from "./session";

function useMembers(projectId: string) {
  const { api, server } = useSession();
  return useQuery({
    queryKey: ["projects", server, projectId, "members"],
    queryFn: () => api.listMembers(projectId),
  });
}

/** Member names by id, for labelling other people's messages. */
export function useNames(projectId: string): Names {
  const members = useMembers(projectId);
  return useMemo(() => Object.fromEntries((members.data ?? []).map((m) => [m.id, m.name])), [members.data]);
}

/** The members the signed-in person blocked: their messages are hidden. */
export function useBlocked(projectId: string): ReadonlySet<string> {
  const members = useMembers(projectId);
  return useMemo(() => new Set((members.data ?? []).filter((m) => m.blocked).map((m) => m.id)), [members.data]);
}
