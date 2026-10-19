import { useT } from "@altair/i18n/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, FolderPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ProjectBadge } from "../../components/shell/project-sidebar";
import { NavToggle, PaneHeader, Sidebar } from "../../components/shell/shell";
import { api, projectsQuery } from "../../lib/api";
import { AltairMark, Button, errorMessage, Input } from "../../lib/ui";

export const Route = createFileRoute("/_app/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(projectsQuery),
  component: ProjectsPage,
});

function ProjectsPage() {
  const t = useT();
  const { data: projects } = useSuspenseQuery(projectsQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: (name: string) => api.createProject({ name }),
    onSuccess: async (project) => {
      setName("");
      await queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey });
      await navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) create.mutate(name.trim());
  }

  return (
    <>
      <Sidebar label={t("projects.title")}>
        <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
          <span className="text-[15px] font-semibold">{t("projects.title")}</span>
          <span className="ml-auto font-mono text-xs text-subtle">{projects.length}</span>
        </div>
        <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                to="/projects/$projectId"
                params={{ projectId: p.id }}
                className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-body hover:bg-hover hover:text-fg"
              >
                <ProjectBadge name={p.name} size={24} />
                <span className="truncate">{p.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Sidebar>

      <main className="flex min-h-0 flex-1 flex-col">
        <PaneHeader className="md:hidden">
          <NavToggle />
          <span className="font-semibold">Altair</span>
        </PaneHeader>
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 py-12 sm:py-20">
            <div className="flex flex-col items-center gap-3 text-center">
              <AltairMark size={44} />
              <h1 className="text-2xl font-semibold tracking-tight">{t("projects.start")}</h1>
              <p className="max-w-md text-[13px] text-subtle">
                {t("projects.intro")}
              </p>
            </div>

            <form onSubmit={onSubmit} className="flex gap-2">
              <label htmlFor="project-name" className="sr-only">
                {t("projects.name")}
              </label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("projects.name")}
                maxLength={120}
                className="h-10"
                autoFocus
              />
              <Button type="submit" disabled={create.isPending || !name.trim()} className="h-10">
                <FolderPlus size={16} aria-hidden="true" />
                {t("projects.create")}
              </Button>
            </form>
            {create.error && <p className="-mt-5 text-sm text-bad">{errorMessage(create.error, t)}</p>}

            {projects.length > 0 && (
              <section aria-labelledby="recent" className="flex flex-col gap-2.5">
                <h2 id="recent" className="text-xs text-subtle">
                  {t("projects.yours")}
                </h2>
                <ul className="grid gap-2.5 sm:grid-cols-2">
                  {projects.map((p) => (
                    <li key={p.id}>
                      <Link
                        to="/projects/$projectId"
                        params={{ projectId: p.id }}
                        className="group flex items-center gap-3 rounded-xl border border-line bg-raised px-3.5 py-3 transition-colors hover:border-edge hover:bg-hover"
                      >
                        <ProjectBadge name={p.name} size={32} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-medium">{p.name}</span>
                          <span className="text-xs text-subtle">
                            {p.role === "owner" ? t("projects.owner") : t("projects.member")}
                          </span>
                        </span>
                        <ArrowRight
                          size={15}
                          className="flex-none text-subtle transition-transform group-hover:translate-x-0.5"
                          aria-hidden="true"
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
