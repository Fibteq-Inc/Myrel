import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";
import type { KnowledgeSection } from "./project-knowledge";

/** The tabs across the top of a project. The conversation is the default and has no `view`. */
export type ProjectView = "chat" | "threads" | "artifacts" | "files" | "knowledge" | "usage";

/**
 * The open tab and what it shows, kept in the URL of every project page so an
 * open thread stays beside whichever tab is chosen.
 */
export type ProjectSearch = {
  view?: Exclude<ProjectView, "chat">;
  /** The open artifact (artifacts tab) or file path (files tab). */
  item?: string;
  /** A pinned artifact version. */
  v?: number;
  /** Memory or instructions, in the knowledge tab. */
  section?: KnowledgeSection;
};

export const PROJECT_SEARCH_KEYS = ["view", "item", "v", "section"] as const;

const VIEWS = ["threads", "artifacts", "files", "knowledge", "usage"];
const SECTIONS = ["memory", "instructions"];

export function validateProjectSearch(s: Record<string, unknown>): ProjectSearch {
  const v = Number(s.v);
  const section = SECTIONS.includes(s.section as string) ? (s.section as KnowledgeSection) : undefined;
  // Memory and instructions used to be sections of the files tab; older links land on their own tab.
  const view = s.view === "files" && section ? "knowledge" : s.view;
  return {
    ...(VIEWS.includes(view as string) && { view: view as ProjectSearch["view"] }),
    ...(typeof s.item === "string" && { item: s.item }),
    ...(Number.isInteger(v) && v > 0 && { v }),
    ...(section && view === "knowledge" && { section }),
  };
}

/** Search params that open a tab, clearing what the previous tab showed. */
export function viewSearch(view: ProjectView, rest: Omit<ProjectSearch, "view"> = {}) {
  return { view: view === "chat" ? undefined : view, item: undefined, v: undefined, section: undefined, ...rest };
}

/** The open tab, and a way to switch tabs without closing the open thread. */
export function useProjectView() {
  const search = useSearch({ strict: false }) as ProjectSearch;
  const navigate = useNavigate();
  const go = useCallback(
    (view: ProjectView, rest: Omit<ProjectSearch, "view"> = {}) =>
      void navigate({
        to: ".",
        search: ((prev: Record<string, unknown>) => ({ ...prev, ...viewSearch(view, rest) })) as never,
      }),
    [navigate],
  );
  return { view: (search.view ?? "chat") as ProjectView, search, go };
}
