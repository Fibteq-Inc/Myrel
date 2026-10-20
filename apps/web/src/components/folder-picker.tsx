import type { Translate } from "@altair/i18n";
import { useT } from "@altair/i18n/react";
import type { Runner } from "@altair/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, ChevronRight, Folder, Home } from "lucide-react";
import { useState } from "react";
import { api, runnersQuery } from "../lib/api";
import { Button, cn, errorMessage, GhostButton, IconButton } from "../lib/ui";

/** Whether this computer can browse and share folders from the web app right now, and why not. */
export function folderPickerBlocker(runner: Runner, t: Translate): string | null {
  if (!runner.online) return t("folderPicker.offline", { computer: runner.name });
  if (!runner.features.includes("folders")) {
    return t("folderPicker.updateRunner", { command: "npx myrel-runner@latest update" });
  }
  return null;
}

/**
 * Browses a computer's folders through its runner and shares the one picked.
 * Only folder names are fetched, never files.
 */
export function FolderPicker({
  runner,
  onShared,
  onCancel,
  className,
}: {
  runner: Runner;
  onShared?: (path: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  // undefined: the computer's home folder.
  const [path, setPath] = useState<string | undefined>();
  const [typed, setTyped] = useState<string | null>(null);
  const listing = useQuery({
    queryKey: ["runners", runner.id, "dirs", path ?? ""],
    queryFn: () => api.listRunnerDirs(runner.id, path),
    retry: false,
  });
  const share = useMutation({
    mutationFn: (folder: string) => api.shareRunnerFolder(runner.id, folder),
    onSuccess: async (_folders, folder) => {
      await queryClient.invalidateQueries({ queryKey: runnersQuery.queryKey });
      onShared?.(folder);
    },
  });

  const current = listing.data;
  const shared = new Set(runner.folders.map((f) => f.path));
  // The home folder and the disk root are too broad to hand to a project.
  const tooBroad = !current || current.path === current.home || current.parent === null;
  const go = (next: string | undefined) => {
    setTyped(null);
    share.reset();
    setPath(next);
  };

  return (
    <div className={cn("flex flex-col gap-2.5 text-[13px]", className)}>
      {/* Not a <form>: the picker sits inside the project's folder form. */}
      <div className="flex items-center gap-1.5">
        <IconButton
          type="button"
          aria-label={t("folderPicker.upLabel")}
          title={t("folderPicker.up")}
          className="size-8 flex-none"
          disabled={!current?.parent}
          onClick={() => current?.parent && go(current.parent)}
        >
          <ArrowUp size={15} />
        </IconButton>
        <IconButton
          type="button"
          aria-label={t("folderPicker.homeLabel")}
          title={t("folderPicker.home")}
          className="size-8 flex-none"
          onClick={() => go(undefined)}
        >
          <Home size={15} />
        </IconButton>
        <input
          aria-label={t("folderPicker.path")}
          value={typed ?? current?.path ?? path ?? ""}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (typed?.trim()) go(typed.trim());
          }}
          spellCheck={false}
          className="h-8 min-w-0 flex-1 rounded-lg border border-edge bg-rail px-2.5 font-mono text-[12px] text-fg outline-none focus:border-accent/70"
        />
      </div>

      <div className="h-56 overflow-y-auto rounded-lg border border-line bg-panel" aria-busy={listing.isFetching}>
        {listing.isPending ? (
          <p className="px-3 py-2.5 text-subtle">{t("folderPicker.loading")}</p>
        ) : listing.error ? (
          <p className="px-3 py-2.5 text-bad">{errorMessage(listing.error, t)}</p>
        ) : current!.dirs.length === 0 ? (
          <p className="px-3 py-2.5 text-subtle">{t("folderPicker.empty")}</p>
        ) : (
          <ul className="py-1">
            {current!.dirs.map((d) => (
              <li key={d.path}>
                <button
                  type="button"
                  onClick={() => go(d.path)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover"
                >
                  <Folder size={14} className="flex-none text-subtle" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  {shared.has(d.path) && (
                    <span className="flex items-center gap-1 text-[11px] text-ok">
                      <Check size={12} aria-hidden="true" />
                      {t("folderPicker.shared")}
                    </span>
                  )}
                  <ChevronRight size={14} className="flex-none text-subtle" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {share.error && <p className="text-bad">{errorMessage(share.error, t)}</p>}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-xs text-subtle">
          {current && tooBroad && t("folderPicker.tooBroad")}
        </span>
        <GhostButton type="button" onClick={onCancel}>
          {t("folderPicker.cancel")}
        </GhostButton>
        {current && shared.has(current.path) ? (
          <Button type="button" onClick={() => onShared?.(current.path)} disabled={!onShared}>
            {t("folderPicker.alreadyShared")}
          </Button>
        ) : (
          <Button type="button" disabled={tooBroad || share.isPending} onClick={() => current && share.mutate(current.path)}>
            {share.isPending
              ? t("folderPicker.sharing")
              : current && !tooBroad
                ? t("folderPicker.shareNamed", { name: folderLabel(current.path) })
                : t("folderPicker.share")}
          </Button>
        )}
      </div>
    </div>
  );
}

function folderLabel(path: string) {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  return name.length > 18 ? `${name.slice(0, 17)}…` : name;
}
