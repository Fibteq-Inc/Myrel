import { useT } from "@myrel/i18n/react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Blocks, LoaderCircle } from "lucide-react";
import { ArtifactList, type ArtifactListItem, Empty } from "../../components/artifacts";
import { NavToggle } from "../../components/shell/shell";
import { api, projectsQuery } from "../../lib/api";

export const Route = createFileRoute("/_app/artifacts")({
  component: AllArtifacts,
});

/** Artifacts across every project the person is in, newest first. */
function AllArtifacts() {
  const t = useT();
  const { data: projects = [], isPending } = useQuery(projectsQuery);
  const lists = useQueries({
    queries: projects.map((p) => ({
      queryKey: ["projects", p.id, "artifacts"],
      queryFn: () => api.listArtifacts(p.id),
    })),
  });
  const loading = isPending || lists.some((l) => l.isPending);
  const items: ArtifactListItem[] = projects
    .flatMap((p, i) => (lists[i]?.data ?? []).map((a) => ({ ...a, origin: p.name })))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 flex-none items-center gap-3 border-b border-line px-4 sm:px-5">
        <NavToggle />
        <Blocks size={17} className="text-muted" aria-hidden="true" />
        <h1 className="text-[15px] font-semibold">{t("sidebar.artifacts")}</h1>
        {items.length > 0 && <span className="ml-auto font-mono text-xs text-subtle">{items.length}</span>}
      </header>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-3 py-5 sm:px-5">
          {loading ? (
            <div className="flex justify-center py-16 text-subtle" role="status">
              <LoaderCircle size={18} className="animate-spin" aria-label={t("common.loading")} />
            </div>
          ) : (
            <ArtifactList
              items={items}
              empty={
                <Empty
                  icon={<Blocks size={20} className="text-subtle" aria-hidden="true" />}
                  title={t("artifacts.noneYet")}
                  body={t("artifacts.noneYetBody")}
                />
              }
            />
          )}
        </div>
      </main>
    </div>
  );
}
