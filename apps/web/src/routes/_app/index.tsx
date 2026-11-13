import { useT } from "@myrel/i18n/react";
import { recentThreads } from "@myrel/client";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { Project } from "@myrel/protocol";
import { ArrowRight, FolderPlus, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LiveThreads, RecentThreads } from "../../components/live-threads";
import { PinButton } from "../../components/project-pin";
import { ProjectBadge } from "../../components/project-badge";
import { NavToggle, PaneHeader } from "../../components/shell/shell";
import { api, notificationsQuery, projectsQuery } from "../../lib/api";
import { useFormat } from "../../lib/format";
import { MyrelMark, Button, cn, errorMessage, GhostButton, Input, useRelativeTime } from "../../lib/ui";

export const Route = createFileRoute("/_app/")({
  // Both shape the page, so it does not change columns as they arrive. The list works without notifications.
  loader: async ({ context }) => {
    await Promise.all([context.queryClient.ensureQueryData(projectsQuery), context.queryClient.prefetchQuery(notificationsQuery)]);
  },
  component: ProjectsPage,
});

function ProjectsPage() {
  const t = useT();
  // Polled so each card's live activity stays current while the list is open.
  const { data: projects } = useSuspenseQuery({ ...projectsQuery, refetchInterval: 15_000 });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  // Someone with projects comes here for them: the form waits behind a button.
  const [creating, setCreating] = useState(false);
  const returning = projects.length > 0;
  const { data: notifications } = useQuery(notificationsQuery);
  const recent = recentThreads(notifications?.notifications ?? [], projects);
  // With nothing to show beside the projects, half the page would stand empty: it stays one column.
  const hasWork = recent.length > 0 || projects.some((p) => p.live?.length);
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

  const form = (
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
  );
  const createError = create.error && <p className="text-sm text-bad">{errorMessage(create.error, t)}</p>;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PaneHeader className="md:hidden">
        <NavToggle />
        <span className="font-semibold">Myrel</span>
      </PaneHeader>
      <div className="flex-1 overflow-y-auto">
        {returning ? (
          <div
            className={cn(
              "mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 py-8 sm:py-12",
              hasWork && "lg:max-w-[1312px] lg:flex-row lg:items-start lg:py-8",
            )}
          >
            <h1 className="sr-only">{t("projects.title")}</h1>
            {hasWork && (
              // The short column stays in view beside a long project list; one page, one scrollbar.
              <div className="flex min-w-0 flex-col gap-8 lg:sticky lg:top-8 lg:flex-1">
                <LiveThreads projects={projects} />
                <RecentThreads rows={recent} className="hidden lg:flex" />
              </div>
            )}
            <section aria-labelledby="projects" className={cn("flex min-w-0 flex-col gap-3", hasWork && "lg:w-[420px] lg:flex-none")}>
              <div className="flex h-8 items-center justify-between gap-3">
                <h2 id="projects" className="text-[15px] font-semibold">
                  {t("projects.title")}
                </h2>
                <GhostButton type="button" aria-expanded={creating} onClick={() => setCreating(!creating)}>
                  <Plus size={15} aria-hidden="true" />
                  {t("sidebar.newProject")}
                </GhostButton>
              </div>
              {creating && form}
              {createError}
              <ul className={cn("grid grid-cols-1 gap-2.5 sm:grid-cols-2", hasWork && "lg:hidden")}>
                {projects.map((p) => (
                  // The name's link covers the whole card, so the pin toggle can sit in it without nesting a button in a link.
                  <li
                    key={p.id}
                    className="group relative flex items-center gap-3 rounded-xl border border-line bg-raised px-3.5 py-3 transition-colors hover:border-edge hover:bg-hover has-[a:focus-visible]:border-accent"
                  >
                    <ProjectBadge name={p.name} icon={p.icon} color={p.color} size={32} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <ProjectLink project={p} />
                      <ProjectActivity project={p} />
                    </span>
                    <ProjectCost project={p} />
                    <PinButton project={p} className="relative -mr-1" />
                    <ArrowRight
                      size={15}
                      className="flex-none text-subtle transition-transform group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </li>
                ))}
              </ul>
              {hasWork && (
                <ul className="hidden flex-col divide-y divide-line overflow-hidden rounded-xl border border-line bg-raised lg:flex">
                  {projects.map((p) => (
                    <li
                      key={p.id}
                      className="group relative flex h-11 items-center gap-2.5 px-3 text-[13.5px] transition-colors hover:bg-hover has-[a:focus-visible]:bg-hover"
                    >
                      <ProjectBadge name={p.name} icon={p.icon} color={p.color} size={24} />
                      <span className="flex min-w-0 flex-1">
                        <ProjectLink project={p} />
                      </span>
                      <span className="flex max-w-[55%] flex-none justify-end">
                        <ProjectActivity project={p} />
                      </span>
                      <ProjectCost project={p} />
                      <PinButton project={p} className="relative -mr-1" />
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {hasWork && <RecentThreads rows={recent} className="lg:hidden" />}
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 py-12 sm:py-20">
            <div className="flex flex-col items-center gap-3 text-center">
              <MyrelMark size={44} />
              <h1 className="text-2xl font-semibold tracking-tight">{t("projects.start")}</h1>
              <p className="max-w-md text-[13px] text-subtle">{t("projects.intro")}</p>
            </div>
            {form}
            {createError}
          </div>
        )}
      </div>
    </main>
  );
}

/** A project's name, whose link covers its whole card or row. */
function ProjectLink({ project }: { project: Project }) {
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      className="truncate font-medium outline-none after:absolute after:inset-0 after:rounded-xl"
    >
      {project.name}
    </Link>
  );
}

/** The card's second line: what is going on in the project right now, or when something last did. */
function ProjectActivity({ project }: { project: Project }) {
  const t = useT();
  const relativeTime = useRelativeTime();
  // The threads when the server lists them, so the coordinator alone does not read as a job.
  const working = project.live ? project.live.filter((l) => l.state === "working").length : (project.activity?.working ?? 0);
  const queued = project.live?.filter((l) => l.state === "queued").length ?? 0;
  const waiting = project.activity?.waiting ?? 0;
  if (!working && !queued && !waiting) {
    return (
      <span className="truncate text-xs text-subtle" title={project.role === "owner" ? t("projects.owner") : t("projects.member")}>
        {relativeTime(project.lastActivityAt ?? project.createdAt)}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2.5 text-xs">
      {working > 0 && (
        <span className="flex min-w-0 items-center gap-1.5 text-accent">
          <span className="size-1.5 flex-none animate-pulse rounded-full bg-accent" aria-hidden="true" />
          <span className="truncate">{t("projects.working", { count: working })}</span>
        </span>
      )}
      {queued > 0 && (
        <span className="flex min-w-0 items-center gap-1.5 text-subtle">
          <span className="size-1.5 flex-none rounded-full bg-subtle" aria-hidden="true" />
          <span className="truncate">{t("projects.queued", { count: queued })}</span>
        </span>
      )}
      {waiting > 0 && (
        <span className="flex min-w-0 items-center gap-1.5 text-warn">
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
    <span className="relative flex-none text-xs tabular-nums text-subtle" title={`${month}\n${total}`} aria-label={`${month}, ${total}`}>
      {cost(project.cost.monthMicros)}
    </span>
  );
}
