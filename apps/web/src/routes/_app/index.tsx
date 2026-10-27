import { useT } from "@myrel/i18n/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { Project } from "@myrel/protocol";
import { ArrowRight, FolderPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ProjectBadge } from "../../components/project-badge";
import { NavToggle, PaneHeader } from "../../components/shell/shell";
import { api, projectsQuery } from "../../lib/api";
import { useFormat } from "../../lib/format";
import { MyrelMark, Button, errorMessage, Input } from "../../lib/ui";

export const Route = createFileRoute("/_app/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(projectsQuery),
  component: ProjectsPage,
});

function ProjectsPage() {
  const t = useT();
  // Polled so each card's live activity stays current while the list is open.
  const { data: projects } = useSuspenseQuery({ ...projectsQuery, refetchInterval: 15_000 });
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
    <main className="flex min-h-0 flex-1 flex-col">
      <PaneHeader className="md:hidden">
        <NavToggle />
        <span className="font-semibold">Myrel</span>
      </PaneHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 py-12 sm:py-20">
          <div className="flex flex-col items-center gap-3 text-center">
            <MyrelMark size={44} />
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
                      <ProjectBadge name={p.name} icon={p.icon} color={p.color} size={32} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{p.name}</span>
                        <ProjectActivity project={p} />
                      </span>
                      <ProjectCost project={p} />
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
  );
}

/** The card's second line: what is going on in the project right now, or the user's role when nothing is. */
function ProjectActivity({ project }: { project: Project }) {
  const t = useT();
  const working = project.activity?.working ?? 0;
  const waiting = project.activity?.waiting ?? 0;
  if (!working && !waiting) {
    return (
      <span className="text-xs text-subtle">{project.role === "owner" ? t("projects.owner") : t("projects.member")}</span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2.5 text-xs">
      {working > 0 && (
        <span className="flex items-center gap-1.5 text-accent">
          <span className="size-1.5 flex-none animate-pulse rounded-full bg-accent" aria-hidden="true" />
          <span className="truncate">{t("projects.working", { count: working })}</span>
        </span>
      )}
      {waiting > 0 && (
        <span className="flex items-center gap-1.5 text-warn">
          <span className="size-1.5 flex-none rounded-full bg-warn" aria-hidden="true" />
          <span className="truncate">{t("projects.waiting", { count: waiting })}</span>
        </span>
      )}
    </span>
  );
}

/** This month's model cost, quiet beside the arrow; the all-time figure on hover. Nothing until a call is priced. */
function ProjectCost({ project }: { project: Project }) {
  const t = useT();
  const { cost } = useFormat();
  if (!project.cost?.totalMicros) return null;
  const month = t("projects.costMonth", { cost: cost(project.cost.monthMicros) });
  const total = t("projects.costTotal", { cost: cost(project.cost.totalMicros) });
  return (
    <span className="flex-none text-xs tabular-nums text-subtle" title={`${month}\n${total}`} aria-label={`${month}, ${total}`}>
      {cost(project.cost.monthMicros)}
    </span>
  );
}
