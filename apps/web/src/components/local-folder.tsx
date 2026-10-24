import { useT } from "@myrel/i18n/react";
import { CLI_NAMES, type CliId, type Project, type ProjectWorkspace } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, Cloud, Folder, FolderPlus, Laptop } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, runnersQuery, workspaceQuery, workspacesQuery } from "../lib/api";
import { Button, errorMessage, GhostButton } from "../lib/ui";
import { FolderPicker, folderPickerBlocker } from "./folder-picker";
import { OnlineDot, RunnerIcon } from "./runners";

/** Header control: the project's local folder and whether its computer is connected; owners can change it. */
export function WorkspaceButton({ project }: { project: Project }) {
  const t = useT();
  const { data: workspace, isPending } = useQuery(workspaceQuery(project.id));
  const { data: workspaces = [] } = useQuery({ ...workspacesQuery(project.id), enabled: !!workspace });
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
        title={
          workspace
            ? t("localFolder.pathOn", { path: workspace.path, computer: workspace.runnerName })
            : t("localFolder.cloudHint")
        }
        className="flex h-8 max-w-[260px] items-center gap-2 rounded-lg border border-edge bg-raised px-2.5 text-[13px] text-fg hover:bg-hover"
      >
        {workspace ? (
          <>
            <OnlineDot online={workspace.online} />
            <Folder size={14} className="flex-none text-muted" aria-hidden="true" />
            <span className="truncate">{folderName(workspace.path)}</span>
            {workspaces.length > 1 && (
              <span className="flex-none text-xs text-subtle" title={t("localFolder.computers", { count: workspaces.length })}>
                +{workspaces.length - 1}
              </span>
            )}
            <span className="sr-only">{workspace.online ? t("localFolder.connected") : t("localFolder.computerOffline")}</span>
          </>
        ) : (
          <>
            <Cloud size={14} className="flex-none text-muted" aria-hidden="true" />
            <span className="hidden sm:inline">{t("localFolder.cloud")}</span>
          </>
        )}
        <ChevronDown size={13} className="flex-none text-subtle" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t("localFolder.title")}
          className="absolute right-0 top-10 z-20 w-[min(360px,calc(100vw-2rem))] rounded-xl border border-edge bg-raised p-4 shadow-2xl shadow-shadow"
        >
          {canEdit ? (
            <WorkspaceForm project={project} workspace={workspace ?? null} onDone={() => setOpen(false)} />
          ) : (
            workspace && (
              <div className="flex flex-col gap-4">
                {(workspaces.length ? workspaces : [workspace]).map((w) => (
                  <WorkspaceSummary key={w.runnerId} workspace={w} several={workspaces.length > 1} />
                ))}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

function WorkspaceSummary({ workspace, several = false }: { workspace: ProjectWorkspace; several?: boolean }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5 text-[13px]">
      <span className="font-mono text-[12.5px]">{workspace.path}</span>
      {workspace.folders.map((f) => (
        <span key={f} className="font-mono text-[12.5px] text-muted">
          {f}
        </span>
      ))}
      <span className="flex items-center gap-1.5 text-subtle">
        <OnlineDot online={workspace.online} />
        {workspace.runnerName} · {CLI_NAMES[workspace.cli] ?? workspace.cli} · {workspace.online ? t("localFolder.connected") : t("localFolder.offline")}
        {several && workspace.isDefault && ` · ${t("localFolder.default")}`}
      </span>
    </div>
  );
}

export function WorkspaceForm({
  project,
  workspace,
  onDone,
}: {
  project: Project;
  workspace: ProjectWorkspace | null;
  onDone: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: runners = [], isPending } = useQuery(runnersQuery);
  const { data: workspaces = [] } = useQuery(workspacesQuery(project.id));
  const [runnerId, setRunnerId] = useState(workspace?.runnerId ?? "");
  const [pickedPath, setPath] = useState(workspace?.path ?? "");
  const [pickedCli, setCli] = useState<CliId | "">(workspace?.cli ?? "");
  const [browsing, setBrowsing] = useState(false);

  // Fall back to the first computer, its first folder and its first CLI.
  const runner = runners.find((r) => r.id === runnerId) ?? runners[0];
  const path = runner?.folders.some((f) => f.path === pickedPath) ? pickedPath : (runner?.folders[0]?.path ?? "");
  const cli = runner?.clis.some((c) => c.id === pickedCli) ? pickedCli : (runner?.clis[0]?.id ?? "");
  // This computer's local folder in the project, when it has one: the form changes that one.
  const inProject = workspaces.find((w) => w.runnerId === runner?.id);
  const pickRunner = (id: string) => {
    const w = workspaces.find((x) => x.runnerId === id);
    setRunnerId(id);
    setPath(w?.path ?? "");
    setCli(w?.cli ?? "");
  };

  const done = () => {
    void queryClient.invalidateQueries({ queryKey: workspaceQuery(project.id).queryKey });
    onDone();
  };
  // A computer's folder goes next to the project's others; the first one is the default.
  const save = useMutation({
    mutationFn: () => api.setWorkspace(project.id, { runnerId: runner!.id, path, cli: cli as CliId, add: true }),
    onSuccess: done,
  });
  const clear = useMutation({ mutationFn: () => api.clearWorkspace(project.id, runner!.id), onSuccess: done });
  const makeDefault = useMutation({ mutationFn: () => api.setDefaultWorkspace(project.id, runner!.id), onSuccess: done });

  const [offlineBefore, offlineAfter = ""] = t("localFolder.runnerOffline", { computer: runner?.name ?? "" }).split(
    "{command}",
  );

  if (isPending) return <p className="text-[13px] text-subtle">{t("common.loading")}</p>;
  if (!runner) {
    return (
      <div className="flex flex-col items-start gap-3 text-[13px]">
        <Laptop size={20} className="text-muted" aria-hidden="true" />
        <p className="text-body">{t("localFolder.connectFirst")}</p>
        <Link to="/devices" className="font-medium text-accent hover:underline" onClick={onDone}>
          {t("localFolder.connectComputer")}
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
        <h3 className="font-semibold">{t("localFolder.title")}</h3>
        <p className="mt-1 text-subtle">{workspace ? t("localFolder.intro") : t("localFolder.introCloud")}</p>
        {workspaces.length > 1 && <p className="mt-1 text-subtle">{t("localFolder.severalHint")}</p>}
      </div>

      {runners.length > 1 && (
        <Field label={t("localFolder.computer")}>
          <div className="flex flex-col gap-1">
            {runners.map((r) => (
              <Choice key={r.id} checked={r.id === runner.id} onChange={() => pickRunner(r.id)} name="runner">
                <RunnerIcon runner={r} size={14} />
                <span className="truncate">{r.name}</span>
                <WorkspaceBadge workspace={workspaces.find((w) => w.runnerId === r.id)} several={workspaces.length > 1} />
                <OnlineDot online={r.online} className="ml-auto" />
              </Choice>
            ))}
          </div>
        </Field>
      )}

      <Field
        label={runners.length > 1 ? t("localFolder.folder") : t("localFolder.folderOn", { computer: runner.name })}
      >
        {browsing ? (
          <FolderPicker
            runner={runner}
            onShared={(shared) => {
              setPath(shared);
              setBrowsing(false);
            }}
            onCancel={() => setBrowsing(false)}
          />
        ) : (
          <>
            {runner.folders.length > 0 && (
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
            {folderPickerBlocker(runner, t) ? (
              runner.folders.length === 0 && (
                <p className="rounded-lg border border-dashed border-edge px-3 py-2.5 text-subtle">
                  {t("localFolder.noFolders", { reason: folderPickerBlocker(runner, t) ?? "" })}
                </p>
              )
            ) : (
              <button
                type="button"
                onClick={() => setBrowsing(true)}
                className="flex items-center gap-2 rounded-lg border border-dashed border-edge px-2.5 py-2 text-muted hover:bg-hover hover:text-fg"
              >
                <FolderPlus size={14} className="flex-none" aria-hidden="true" />
                {runner.folders.length === 0 ? t("localFolder.chooseFolder") : t("localFolder.addFolder")}
              </button>
            )}
          </>
        )}
      </Field>

      <Field label={t("localFolder.cli")}>
        {runner.clis.length === 0 ? (
          <p className="text-subtle">
            {runner.online
              ? t("localFolder.noClis")
              : t("localFolder.startRunner")}
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
          <span>
            {offlineBefore}
            <code className="font-mono text-fg">npx myrel-runner service install</code>
            {offlineAfter}
          </span>
        </p>
      )}
      {(save.error || clear.error || makeDefault.error) && (
        <p className="text-bad">{errorMessage(save.error ?? clear.error ?? makeDefault.error, t)}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {inProject && (
          <GhostButton type="button" onClick={() => clear.mutate()} disabled={clear.isPending}>
            {t("localFolder.disconnect")}
          </GhostButton>
        )}
        {inProject && !inProject.isDefault && (
          <GhostButton type="button" onClick={() => makeDefault.mutate()} disabled={makeDefault.isPending}>
            {t("localFolder.makeDefault")}
          </GhostButton>
        )}
        <Button type="submit" className="ml-auto" disabled={!path || !cli || save.isPending}>
          {inProject ? t("localFolder.save") : workspace ? t("localFolder.addComputer") : t("localFolder.useFolder")}
        </Button>
      </div>
    </form>
  );
}

/** Whether a computer already works for the project, and as its default. */
function WorkspaceBadge({ workspace, several }: { workspace?: ProjectWorkspace; several: boolean }) {
  const t = useT();
  if (!workspace) return null;
  return (
    <span className="flex-none rounded-md bg-hover px-1.5 py-0.5 text-[11px] text-muted">
      {several && workspace.isDefault ? t("localFolder.default") : t("localFolder.inProject")}
    </span>
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
