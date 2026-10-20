import { useT } from "@myrel/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, X } from "lucide-react";
import { createContext, type ReactNode, Suspense, useCallback, useContext, useEffect, useRef, useState } from "react";
import { projectQuery } from "../lib/api";
import { IconButton } from "../lib/ui";
import { ProjectSettings, roleKey } from "./project-settings";

const SettingsDialogContext = createContext<(() => void) | null>(null);

/** Lets anything inside a project open its settings in a dialog over the page. */
export function ProjectSettingsDialogProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  return (
    <SettingsDialogContext.Provider value={show}>
      {children}
      {open && <ProjectSettingsDialog projectId={projectId} onClose={() => setOpen(false)} />}
    </SettingsDialogContext.Provider>
  );
}

/** Opens the current project's settings dialog. */
export function useOpenProjectSettings() {
  const open = useContext(SettingsDialogContext);
  if (!open) throw new Error("useOpenProjectSettings must be used inside <ProjectSettingsDialogProvider>");
  return open;
}

function ProjectSettingsDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { data: project } = useQuery(projectQuery(projectId));
  const t = useT();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return (
    <dialog
      ref={ref}
      {...{ closedby: "any" }}
      aria-labelledby="project-settings-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog itself (for browsers without closedby).
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="m-auto max-h-[min(860px,calc(100dvh-48px))] w-[min(720px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-line bg-ground p-0 text-fg shadow-2xl backdrop:bg-black/60 max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:max-w-none max-sm:rounded-none open:flex"
    >
      <header className="flex h-14 flex-none items-center gap-3 border-b border-line pl-5 pr-3">
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <h2 id="project-settings-title" className="truncate text-[15px] font-semibold">
            {project ? t("projectSettings.dialogTitle", { name: project.name }) : t("chat.projectSettings")}
          </h2>
          {project && (
            <span className="text-xs text-subtle">
              {t("projectSettings.youAre", { role: t(roleKey(project.role)) })}
            </span>
          )}
        </div>
        <IconButton type="button" onClick={onClose} aria-label={t("projectSettings.close")} title={t("projectSettings.close")} className="size-9">
          <X size={17} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-10 px-5 py-6 sm:px-7">
          <Suspense
            fallback={
              <div className="flex justify-center py-16 text-subtle">
                <LoaderCircle size={20} className="animate-spin" aria-label={t("common.loading")} />
              </div>
            }
          >
            <ProjectSettings projectId={projectId} header={false} />
          </Suspense>
        </div>
      </div>
    </dialog>
  );
}
