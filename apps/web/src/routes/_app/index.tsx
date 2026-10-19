import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { api, projectsQuery } from "../../lib/api";
import { Button, errorMessage, Input } from "../../lib/ui";

export const Route = createFileRoute("/_app/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(projectsQuery),
  component: ProjectsPage,
});

function ProjectsPage() {
  const { data: projects } = useSuspenseQuery(projectsQuery);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: (name: string) => api.createProject({ name }),
    onSuccess: () => {
      setName("");
      return queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) create.mutate(name.trim());
  }

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <h1 className="text-xl font-semibold">Projects</h1>
      <form onSubmit={onSubmit} className="flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" maxLength={120} />
        <Button type="submit" disabled={create.isPending || !name.trim()}>
          Create
        </Button>
      </form>
      {create.error && <p className="text-sm text-red-600">{errorMessage(create.error)}</p>}
      {projects.length === 0 ? (
        <p className="text-sm text-neutral-500">No projects yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                to="/projects/$projectId"
                params={{ projectId: p.id }}
                className="flex items-center justify-between px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-900"
              >
                <span>{p.name}</span>
                <span className="text-xs text-neutral-500">{new Date(p.createdAt).toLocaleDateString()}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
