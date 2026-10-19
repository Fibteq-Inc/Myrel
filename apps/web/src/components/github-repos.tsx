import type { GithubRepo, ProjectRepo } from "@altair/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  ExternalLink,
  FolderGit2,
  GitBranch,
  LoaderCircle,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Section } from "./settings";
import { api, githubReposQuery, githubStatusQuery, projectReposQuery } from "../lib/api";
import { errorMessage, GhostButton, IconButton, Input } from "../lib/ui";

/** Messages for `?github=` after the GitHub round trip (see apps/api/src/routes/github.ts). */
const GITHUB_RESULTS: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "GitHub is connected. Pick the repositories this project works on." },
  no_code: {
    ok: false,
    text: "GitHub did not sign you in. Turn on “Request user authorization (OAuth) during installation” in the GitHub App, then try again.",
  },
  error: { ok: false, text: "Connecting GitHub failed. Try again." },
  invalid_state: { ok: false, text: "That GitHub link expired or belongs to another account. Try again." },
};

/** The "GitHub repositories" section of a project's settings page. `githubResult` is `?github=` after connecting. */
export function GithubRepos({
  projectId,
  canManage,
  githubResult,
}: {
  projectId: string;
  canManage: boolean;
  githubResult?: string;
}) {
  const status = useQuery(githubStatusQuery);
  const repos = useQuery(projectReposQuery(projectId));
  const result = githubResult ? GITHUB_RESULTS[githubResult] : undefined;
  const returnTo = `/settings/projects/${projectId}`;

  return (
    <Section
      title="GitHub repositories"
      description="Threads read the code in these repositories. Cloning, running and opening pull requests come next."
    >
      {result && <Notice ok={result.ok}>{result.text}</Notice>}

      {status.isPending ? (
        <Loading />
      ) : status.data && !status.data.configured ? (
        <Notice ok={false}>
          GitHub is not set up on this server yet. The server admin creates a GitHub App and adds its settings to the
          Worker (see <code>apps/api/src/github/README.md</code>).
        </Notice>
      ) : (
        <>
          <RepoList projectId={projectId} repos={repos.data ?? []} loading={repos.isPending} canEdit={canManage} />
          {canManage &&
            (status.data?.installations.length ? (
              <RepoPicker projectId={projectId} connected={repos.data ?? []} />
            ) : (
              <ConnectCard returnTo={returnTo} />
            ))}
          {status.data?.installations.length ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-subtle">
              <span>
                Connected:{" "}
                {status.data.installations.map((i) => i.accountLogin).join(", ")}
              </span>
              <a className="inline-flex items-center gap-1 hover:text-fg" href={api.githubConnectUrl("install", returnTo)}>
                <ExternalLink size={13} aria-hidden="true" />
                Add an account or repositories
              </a>
              <a className="inline-flex items-center gap-1 hover:text-fg" href={api.githubConnectUrl("authorize", returnTo)}>
                <RefreshCw size={13} aria-hidden="true" />
                Refresh from GitHub
              </a>
            </div>
          ) : null}
        </>
      )}
    </Section>
  );
}

function ConnectCard({ returnTo }: { returnTo: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-edge bg-panel p-4">
      <p className="text-[13px] text-body">
        Install the Altair GitHub App on your account or organization and choose which repositories it can see.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={api.githubConnectUrl("install", returnTo)}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-fg px-3 text-sm font-medium text-ground hover:bg-white"
        >
          <GithubMark />
          Connect GitHub
        </a>
        <a
          href={api.githubConnectUrl("authorize", returnTo)}
          className="inline-flex h-9 items-center rounded-lg px-3 text-[13px] text-muted hover:bg-hover hover:text-fg"
        >
          Already installed? Sign in with GitHub
        </a>
      </div>
    </div>
  );
}

function RepoList({
  projectId,
  repos,
  loading,
  canEdit,
}: {
  projectId: string;
  repos: ProjectRepo[];
  loading: boolean;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (repoId: number) => api.removeProjectRepo(projectId, repoId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectReposQuery(projectId).queryKey }),
  });

  if (loading) return <Loading />;
  if (repos.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-edge px-4 py-6 text-center text-[13px] text-subtle">
        No repositories connected yet.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-edge">
      {repos.map((r) => (
        <li key={r.repoId} className="flex items-center gap-3 bg-panel px-3.5 py-3">
          <FolderGit2 size={17} className="flex-none text-muted" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <a
              href={`https://github.com/${r.fullName}`}
              target="_blank"
              rel="noreferrer"
              className="block truncate font-medium hover:underline"
            >
              {r.fullName}
            </a>
            <span className="flex items-center gap-3 text-xs text-subtle">
              <span className="inline-flex items-center gap-1">
                <GitBranch size={12} aria-hidden="true" />
                {r.defaultBranch}
              </span>
              {r.private && (
                <span className="inline-flex items-center gap-1">
                  <Lock size={12} aria-hidden="true" />
                  Private
                </span>
              )}
            </span>
          </div>
          {canEdit && (
            <IconButton
              type="button"
              aria-label={`Disconnect ${r.fullName}`}
              title="Disconnect"
              disabled={remove.isPending}
              onClick={() => remove.mutate(r.repoId)}
            >
              <Trash2 size={15} />
            </IconButton>
          )}
        </li>
      ))}
    </ul>
  );
}

function RepoPicker({ projectId, connected }: { projectId: string; connected: ProjectRepo[] }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const queryClient = useQueryClient();
  const available = useQuery({ ...githubReposQuery, enabled: open });
  const add = useMutation({
    mutationFn: (repo: GithubRepo) => api.addProjectRepo(projectId, { installationId: repo.installationId, repoId: repo.id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectReposQuery(projectId).queryKey }),
  });

  if (!open) {
    return (
      <GhostButton type="button" className="self-start" onClick={() => setOpen(true)}>
        <Plus size={14} aria-hidden="true" />
        Add repository
      </GhostButton>
    );
  }

  const taken = new Set(connected.map((r) => r.repoId));
  const q = filter.trim().toLowerCase();
  const matches = (available.data ?? []).filter((r) => !taken.has(r.id) && r.fullName.toLowerCase().includes(q));

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-edge bg-panel p-3">
      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" aria-hidden="true" />
        <Input
          autoFocus
          className="pl-9"
          placeholder="Search repositories"
          aria-label="Search repositories"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {add.error && <Notice ok={false}>{errorMessage(add.error)}</Notice>}
      <ul className="max-h-72 overflow-y-auto">
        {available.isPending ? (
          <Loading />
        ) : matches.length === 0 ? (
          <li className="px-2 py-4 text-center text-[13px] text-subtle">
            {available.data?.length ? "No other repositories match." : "The app cannot see any repositories yet."}
          </li>
        ) : (
          matches.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                disabled={add.isPending}
                onClick={() => add.mutate(r)}
                className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-hover disabled:opacity-50"
              >
                <FolderGit2 size={15} className="flex-none text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.fullName}</span>
                  {r.description && <span className="block truncate text-xs text-subtle">{r.description}</span>}
                </span>
                {r.private && <Lock size={13} className="flex-none text-subtle" aria-label="Private" />}
                {add.isPending && add.variables?.id === r.id ? (
                  <LoaderCircle size={15} className="animate-spin text-muted" aria-hidden="true" />
                ) : (
                  <Plus size={15} className="text-muted" aria-hidden="true" />
                )}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function Notice({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] text-body ${
        ok ? "border-[#1e3b2c] bg-[#0f1713]" : "border-[#3b3218] bg-[#17150f]"
      }`}
    >
      {ok ? (
        <CircleCheck size={16} className="mt-0.5 flex-none text-ok" aria-hidden="true" />
      ) : (
        <CircleAlert size={16} className="mt-0.5 flex-none text-warn" aria-hidden="true" />
      )}
      <span>{children}</span>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex justify-center py-4 text-muted">
      <LoaderCircle size={18} className="animate-spin" aria-label="Loading" />
    </div>
  );
}

/** GitHub's mark (Lucide dropped brand icons). */
function GithubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
