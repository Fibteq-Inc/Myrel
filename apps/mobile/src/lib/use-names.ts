import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Names } from "../components/message";
import { useSession } from "./session";

/** Member names by id, for labelling other people's messages. */
export function useNames(projectId: string): Names {
  const { api, server } = useSession();
  const members = useQuery({
    queryKey: ["projects", server, projectId, "members"],
    queryFn: () => api.listMembers(projectId),
  });
  return useMemo(() => Object.fromEntries((members.data ?? []).map((m) => [m.id, m.name])), [members.data]);
}
