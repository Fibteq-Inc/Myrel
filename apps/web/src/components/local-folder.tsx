import { CLI_NAMES, type CliId, type Project, type ProjectWorkspace } from "@altair/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, Folder, FolderPlus, Laptop } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, runnersQuery, workspaceQuery } from "../lib/api";
import { Button, errorMessage, GhostButton } from "../lib/ui";
import { OnlineDot, RunnerIcon } from "./runners";

/** Header control: the project's local folder and whether its computer is connected; owners can change it. */
export function WorkspaceButton({ project }: { project: Project }) {
  const { data: workspace, isPending } = useQuery(workspaceQuery(project.id));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (isPending) return null;
  const canEdit = project.role === "owner" || project.role === "admin";
  if (!workspace && !canEdit) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        title={workspace ? `${workspace.path} on ${workspace.runnerName}` : "Work in a folder on your computer"}
        className="flex h-8 max-w-[260px] items-center gap-2 rounded-lg border border-edge bg-raised px-2.5 text-[13px] text-fg hover:bg-hover"
      >
        {workspace ? (
          <>
            <OnlineDot online={workspace.online} />
            <Folder size={14} className="flex-none text-muted" aria-hidden="true" />
            <span className="truncate">{folderName(workspace.path)}</span>
            <span className="sr-only">{workspace.online ? "connected" : "computer offline"}</span>
          </>
        ) : (
          <>
            <FolderPlus size={14} className="flex-none text-muted" aria-hidden="true" />
            <span className="hidden sm:inline">Local folder</span>
          </>
        )}
        <ChevronDown size={13} className="flex-none text-subtle" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Local folder"
          className="absolute right-0 top-10 z-20 w-[min(360px,calc(100vw-2rem))] rounded-xl border border-edge bg-raised p-4 shadow-2xl shadow-black/50"
        >
          {canEdit ? (
            <WorkspaceForm project={project} workspace={workspace ?? null} onDone={() => setOpen(false)} />
          ) : (
            workspace && <WorkspaceSummary workspace={workspace} />
          )}
        </div>
      )}
    </div>
  );
}

function WorkspaceSummary({ workspace }: { workspace: ProjectWorkspace }) {
  return (
    <div className="flex flex-col gap-1.5 text-[13px]">
      <span className="font-mono text-[12.5px]">{workspace.path}</span>
      <span className="flex items-center gap-1.5 text-subtle">
        <OnlineDot online={workspace.online} />
        {workspace.runnerName} · {CLI_NAMES[workspace.cli]} · {workspace.online ? "connected" : "offline"}
      </span>
    </div>
  );
}

function WorkspaceForm({
  project,
  workspace,
  onDone,
}: {
  project: Project;
  workspace: ProjectWorkspace | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: runners = [], isPending } = useQuery(runnersQuery);
  const [runnerId, setRunnerId] = useState(workspace?.runnerId ?? "");
  const [pickedPath, setPath] = useState(workspace?.path ?? "");
  const [pickedCli, setCli] = useState<CliId | "">(workspace?.cli ?? "");

  // Fall back to the first computer, its first folder and its first CLI.
  const runner = runners.find((r) => r.id === runnerId) ?? runners[0];
  const path = runner?.folders.some((f) => f.path === pickedPath) ? pickedPath : (runner?.folders[0]?.path ?? "");
  const cli = runner?.clis.some((c) => c.id === pickedCli) ? pickedCli : (runner?.clis[0]?.id ?? "");

  const done = (next: ProjectWorkspace | null) => {
    queryClient.setQueryData(workspaceQuery(project.id).queryKey, next);
    onDone();
  };
  const save = useMutation({
    mutationFn: () => api.setWorkspace(project.id, { runnerId: runner!.id, path, cli: cli as CliId }),
    onSuccess: done,
  });
  const clear = useMutation({ mutationFn: () => api.clearWorkspace(project.id), onSuccess: () => done(null) });

  if (isPending) return <p className="text-[13px] text-subtle">Loading…</p>;
  if (!runner) {
    return (
      <div className="flex flex-col items-start gap-3 text-[13px]">
        <Laptop size={20} className="text-muted" aria-hidden="true" />
        <p className="text-body">
          Connect your computer first. Then this project can work in one of its folders with your own Claude Code, Codex
          or Gemini CLI.
        </p>
        <Link to="/devices" className="font-medium text-accent hover:underline" onClick={onDone}>
          Connect a computer
        </Link>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4 text-[13px]"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div>
        <h3 className="font-semibold">Local folder</h3>
        <p className="mt-1 text-subtle">Threads in this project run their coding tasks here, on your computer.</p>
      </div>

      {runners.length > 1 && (
        <Field label="Computer">
          <div className="flex flex-col gap-1">
            {runners.map((r) => (
              <Choice key={r.id} checked={r.id === runner.id} onChange={() => setRunnerId(r.id)} name="runner">
                <RunnerIcon runner={r} size={14} />
                <span className="truncate">{r.name}</span>
                <OnlineDot online={r.online} className="ml-auto" />
              </Choice>
            ))}
          </div>
        </Field>
      )}

      <Field label={runners.length > 1 ? "Folder" : `Folder on ${runner.name}`}>
        {runner.folders.length === 0 ? (
          <p className="rounded-lg border border-dashed border-edge px-3 py-2.5 text-subtle">
            No shared folders yet. In a terminal, run{" "}
            <code className="font-mono text-fg">npx altair-runner share</code> inside your project folder.
          </p>
        ) : (
          <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
            {runner.folders.map((f) => (
              <Choice key={f.path} checked={f.path === path} onChange={() => setPath(f.path)} name="folder">
                <Folder size={14} className="flex-none text-subtle" aria-hidden="true" />
                <span className="truncate font-mono text-[12.5px]" title={f.path}>
                  {f.path}
                </span>
              </Choice>
            ))}
          </div>
        )}
      </Field>

      <Field label="Coding CLI">
        {runner.clis.length === 0 ? (
          <p className="text-subtle">
            {runner.online
              ? "No Claude Code, Codex or Gemini CLI found on this computer."
              : "Start altair-runner on this computer to see its CLIs."}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {runner.clis.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={c.id === cli}
                onClick={() => setCli(c.id)}
                className={`rounded-lg border px-2.5 py-1.5 ${
                  c.id === cli ? "border-accent/70 bg-accent-soft text-fg" : "border-edge text-muted hover:bg-hover"
                }`}
              >
                {CLI_NAMES[c.id]}
              </button>
            ))}
          </div>
        )}
      </Field>

      {!runner.online && (
        <p className="flex items-center gap-2 text-subtle">
          <OnlineDot online={false} />
          {runner.name} is offline. Run <code className="font-mono text-fg">npx altair-runner start</code> on it.
        </p>
      )}
      {(save.error || clear.error) && <p className="text-bad">{errorMessage(save.error ?? clear.error)}</p>}

      <div className="flex items-center gap-2">
        {workspace && (
          <GhostButton type="button" onClick={() => clear.mutate()} disabled={clear.isPending}>
            Disconnect
          </GhostButton>
        )}
        <Button type="submit" className="ml-auto" disabled={!path || !cli || save.isPending}>
          {workspace ? "Save" : "Use this folder"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-xs text-subtle">{label}</legend>
      {children}
    </fieldset>
  );
}

function Choice({
  checked,
  onChange,
  name,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  name: string;
  children: React.ReactNode;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 ${
        checked ? "border-accent/70 bg-accent-soft" : "border-transparent hover:bg-hover"
      }`}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />
      {children}
    </label>
  );
}

function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
