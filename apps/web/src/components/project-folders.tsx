import { useT } from "@myrel/i18n/react";
import { CLI_NAMES, type Project, type ProjectWorkspace } from "@myrel/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, FolderPlus, X } from "lucide-react";
import { useState } from "react";
import { api, runnersQuery, workspaceQuery } from "../lib/api";
import { Button, errorMessage, GhostButton, IconButton } from "../lib/ui";
import { FolderPicker, folderPickerBlocker } from "./folder-picker";
import { WorkspaceForm } from "./local-folder";
import { OnlineDot } from "./runners";
import { List, Notice, Row, Section } from "./settings";

/**
 * The folders on the person's computer the project's agent may work in: its main folder and any
 * others. Anything outside them, Claude Code asks about in the thread first.
 */
export function ProjectFolders({ project, canManage }: { project: Project; canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: workspace, isPending } = useQuery(workspaceQuery(project.id));
  const { data: runners = [] } = useQuery({ ...runnersQuery, enabled: canManage });
  // connect: the main folder form; pick: browsing for another folder.
  const [mode, setMode] = useState<"idle" | "connect" | "pick">("idle");

  const saved = (next: ProjectWorkspace) => queryClient.setQueryData(workspaceQuery(project.id).queryKey, next);
  const add = useMutation({
    mutationFn: (path: string) => api.addWorkspaceFolder(project.id, path),
    onSuccess: (next) => {
      saved(next);
      setMode("idle");
    },
  });
  const remove = useMutation({ mutationFn: (path: string) => api.removeWorkspaceFolder(project.id, path), onSuccess: saved });

  if (isPending) return null;
  const description = (
    <>
      {t("projectFolders.description")}
      {!canManage && ` ${t("projectFolders.readOnly")}`}
    </>
  );

  if (!workspace || mode === "connect") {
    return (
      <Section title={t("projectFolders.title")} description={description}>
        {mode === "connect" ? (
          <div className="rounded-xl border border-line bg-raised p-4">
            <WorkspaceForm project={project} workspace={workspace ?? null} onDone={() => setMode("idle")} />
          </div>
        ) : (
          <>
            <p className="text-[13px] text-subtle">{t("projectFolders.cloud")}</p>
            {canManage && (
              <Button type="button" onClick={() => setMode("connect")}>
                {t("projectFolders.connect")}
              </Button>
            )}
          </>
        )}
      </Section>
    );
  }

  const runner = runners.find((r) => r.id === workspace.runnerId);
  const blocker = runner ? folderPickerBlocker(runner, t) : null;
  const rows = [
    <Row key="main">
      <Folder size={16} className="flex-none text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[12.5px]" title={workspace.path}>
          {workspace.path}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-subtle">
          <OnlineDot online={workspace.online} />
          {t("projectFolders.main")} · {t("projectFolders.mainHint", { computer: workspace.runnerName, cli: CLI_NAMES[workspace.cli] })}
        </div>
      </div>
      {canManage && (
        <GhostButton type="button" onClick={() => setMode("connect")}>
          {t("projectFolders.change")}
        </GhostButton>
      )}
    </Row>,
    ...workspace.folders.map((path) => (
      <Row key={path}>
        <Folder size={16} className="flex-none text-subtle" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12.5px]" title={path}>
            {path}
          </div>
          <div className="mt-0.5 text-xs text-subtle">{t("projectFolders.other")}</div>
        </div>
        {canManage && (
          <IconButton
            type="button"
            className="size-8 flex-none"
            aria-label={t("projectFolders.remove", { path })}
            title={t("projectFolders.remove", { path })}
            disabled={remove.isPending}
            onClick={() => remove.mutate(path)}
          >
            <X size={15} />
          </IconButton>
        )}
      </Row>
    )),
  ];

  return (
    <Section title={t("projectFolders.title")} description={description}>
      <List empty="">{rows}</List>
      <p className="text-[13px] text-subtle">
        {workspace.cli === "claude" ? t("projectFolders.asksClaude") : t("projectFolders.asksOther", { cli: CLI_NAMES[workspace.cli] })}
      </p>
      {canManage &&
        runner &&
        (mode === "pick" ? (
          <div className="rounded-xl border border-line bg-raised p-3">
            <FolderPicker runner={runner} onShared={(path) => add.mutate(path)} onCancel={() => setMode("idle")} />
          </div>
        ) : blocker ? (
          <p className="text-[13px] text-subtle">{blocker}</p>
        ) : (
          <GhostButton type="button" className="flex items-center gap-2" onClick={() => setMode("pick")}>
            <FolderPlus size={15} aria-hidden="true" />
            {t("projectFolders.add")}
          </GhostButton>
        ))}
      {(add.error || remove.error) && <Notice>{errorMessage(add.error ?? remove.error, t)}</Notice>}
    </Section>
  );
}
