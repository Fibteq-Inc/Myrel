import { useT } from "@myrel/i18n/react";
import type { Task } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, File, Folder, FolderTree, GitCommitHorizontal } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { EmptyTab } from "./workspace-panel";

/**
 * What the thread's cloud tasks saved in its workspace: browse folders, read a
 * file, and see the saves. Refreshes when a task finishes.
 */
export function FilesTab({ projectId, threadId, tasks }: { projectId: string; threadId: string; tasks: Task[] }) {
  const t = useT();
  const [path, setPath] = useState("");
  const lastDone = tasks.filter((task) => task.status !== "running").at(-1)?.id ?? null;
  const { data, isPending, error } = useQuery({
    queryKey: ["projects", projectId, "threads", threadId, "files", path, lastDone],
    queryFn: () => api.threadFiles(projectId, threadId, path),
  });

  if (isPending) return <p className="p-4 text-[13px] text-subtle">{t("common.loading")}</p>;
  if (error) return <p className="p-4 text-[13px] text-bad">{t("files.workspaceError")}</p>;
  if (!data) {
    return (
      <EmptyTab icon={FolderTree} title={t("files.workspaceEmpty")}>
        {t("files.workspaceEmptyBody")}
      </EmptyTab>
    );
  }

  const parts = path.split("/").filter(Boolean);
  return (
    <div className="flex flex-col gap-4 p-4 text-[13px]">
      <nav aria-label={t("files.workspacePath")} className="flex flex-wrap items-center gap-1 text-muted">
        <button type="button" onClick={() => setPath("")} className="rounded px-1 hover:bg-hover hover:text-fg">
          {t("files.workspaceRoot")}
        </button>
        {parts.map((part, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight size={12} className="text-subtle" aria-hidden="true" />
            <button
              type="button"
              onClick={() => setPath(parts.slice(0, i + 1).join("/"))}
              className="rounded px-1 font-mono text-[12.5px] hover:bg-hover hover:text-fg"
            >
              {part}
            </button>
          </span>
        ))}
        <span className="ml-auto font-mono text-[11.5px] text-subtle">{data.ref}</span>
      </nav>

      {data.file ? (
        data.file.text === null ? (
          <p className="text-subtle">{t("files.workspaceBinary", { size: String(data.file.size) })}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <pre className="max-h-[60vh] overflow-auto rounded-lg border border-line bg-[#08080a] px-3 py-2 font-mono text-[12px] leading-[1.55] text-body">
              {data.file.text}
            </pre>
            {data.file.truncated && <p className="text-xs text-subtle">{t("files.workspaceTruncated")}</p>}
          </div>
        )
      ) : data.entries ? (
        data.entries.length === 0 ? (
          <p className="text-subtle">{t("files.workspaceEmptyFolder")}</p>
        ) : (
          <ul className="flex flex-col">
            {data.entries.map((e) => (
              <li key={e.path}>
                <button
                  type="button"
                  onClick={() => setPath(e.path)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
                >
                  {e.type === "folder" ? (
                    <Folder size={14} className="flex-none text-accent" aria-hidden="true" />
                  ) : (
                    <File size={14} className="flex-none text-subtle" aria-hidden="true" />
                  )}
                  <span className="truncate font-mono text-[12.5px]">{e.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="text-subtle">{t("files.workspaceMissing")}</p>
      )}

      {data.commits.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs text-subtle">{t("files.workspaceHistory")}</h3>
          <ul className="flex flex-col gap-1">
            {data.commits.map((c) => (
              <li key={c.hash} className="flex items-center gap-2 text-muted">
                <GitCommitHorizontal size={14} className="flex-none text-subtle" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{c.message}</span>
                <time dateTime={c.at} className="flex-none text-xs text-subtle">
                  {new Date(c.at).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
