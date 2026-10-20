import type { Member, Project } from "@myrel/protocol";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useProject } from "./use-project";

type ProjectContextValue = ReturnType<typeof useProject> & {
  project: Project;
  members: Member[];
  /** Member id → display name. */
  names: Record<string, string>;
};

const ProjectContext = createContext<ProjectContextValue | null>(null);

/** One live connection per open project, shared by its sidebar, chat and thread views. */
export function ProjectProvider({
  project,
  members,
  children,
}: {
  project: Project;
  members: Member[];
  children: ReactNode;
}) {
  const live = useProject(project.id);
  const names = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m.name])), [members]);
  return <ProjectContext.Provider value={{ ...live, project, members, names }}>{children}</ProjectContext.Provider>;
}

export function useProjectContext() {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProjectContext must be used inside <ProjectProvider>");
  return value;
}
