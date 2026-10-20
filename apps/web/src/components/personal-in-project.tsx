import { useT } from "@myrel/i18n/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookMarked, Globe, LoaderCircle, SquareTerminal } from "lucide-react";
import { api, personalInProjectQuery } from "../lib/api";
import { errorMessage } from "../lib/ui";
import { Notice, Section } from "./settings";
import { Switch } from "./ui/controls";

type Item = { id: string; name: string; description: string; icon: "skill" | "http" | "stdio"; inProject: boolean; enabled: boolean };

/**
 * The person's own skills or connectors, each with a switch for this project. They start off in
 * every project, and only work in threads that work for this person.
 */
export function PersonalInProject({ projectId, kind }: { projectId: string; kind: "skills" | "connectors" }) {
  const t = useT();
  const queryClient = useQueryClient();
  const query = useQuery(personalInProjectQuery(projectId));
  const key = personalInProjectQuery(projectId).queryKey;
  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api.setPersonalInProject(projectId, kind, id, on),
    onMutate: ({ id, on }) =>
      queryClient.setQueryData(key, (data) =>
        data && {
          ...data,
          skills: data.skills.map((s) => (kind === "skills" && s.id === id ? { ...s, inProject: on } : s)),
          connectors: data.connectors.map((c) => (kind === "connectors" && c.id === id ? { ...c, inProject: on } : c)),
        },
      ),
    onError: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const items: Item[] =
    kind === "skills"
      ? (query.data?.skills ?? []).map((s) => ({ id: s.id, name: s.name, description: s.description, icon: "skill", inProject: s.inProject, enabled: s.enabled }))
      : (query.data?.connectors ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          description: c.transport === "http" ? (c.url ?? "") : [c.command, ...c.args].join(" "),
          icon: c.transport,
          inProject: c.inProject,
          enabled: c.enabled,
        }));

  return (
    <Section
      title={kind === "skills" ? t("personalInProject.skillsTitle") : t("personalInProject.connectorsTitle")}
      description={kind === "skills" ? t("personalInProject.skillsDescription") : t("personalInProject.connectorsDescription")}
    >
      {query.isPending ? (
        <LoaderCircle size={15} className="animate-spin text-subtle" aria-hidden="true" />
      ) : query.error ? (
        <Notice tone="bad">{errorMessage(query.error, t)}</Notice>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-edge px-4 py-5 text-center text-[13px] text-subtle">
          {kind === "skills" ? t("personalInProject.noSkills") : t("personalInProject.noConnectors")}{" "}
          <Link to={kind === "skills" ? "/settings/skills" : "/settings/connectors"} className="text-accent hover:underline">
            {t("personalInProject.addInSettings")}
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-edge">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 bg-panel px-3.5 py-2.5">
              <span aria-hidden="true" className="flex size-8 flex-none items-center justify-center rounded-lg bg-hover text-muted">
                {item.icon === "skill" ? <BookMarked size={15} /> : item.icon === "http" ? <Globe size={15} /> : <SquareTerminal size={15} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{item.name}</div>
                <div className="truncate text-xs text-subtle">
                  {item.enabled ? item.description : t("personalInProject.offEverywhere")}
                </div>
              </div>
              <Switch
                checked={item.inProject}
                disabled={toggle.isPending}
                onChange={(e) => toggle.mutate({ id: item.id, on: e.target.checked })}
                aria-label={t("personalInProject.useHere", { name: item.name })}
              />
            </li>
          ))}
        </ul>
      )}
      {toggle.error && <Notice tone="bad">{errorMessage(toggle.error, t)}</Notice>}
    </Section>
  );
}
