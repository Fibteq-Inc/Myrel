import { useT } from "@altair/i18n/react";
import type { Attachment, ProjectFile } from "@altair/protocol";
import { useQuery } from "@tanstack/react-query";
import { Download, File, FileCode, FileImage, FileText, LoaderCircle, Paperclip, X } from "lucide-react";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";
import { IconButton } from "../lib/ui";
import { useProjectView } from "./project-view";

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Upload names start with a time stamp so they stay unique; people only need the original name. */
export function displayName(path: string) {
  const name = path.split("/").at(-1)!;
  return path.startsWith("uploads/") ? name.replace(/^[0-9a-z]+-/, "") : name;
}

type Kind = "image" | "pdf" | "markdown" | "text" | "other";

function kindOf(path: string, contentType: string): Kind {
  if (contentType.startsWith("image/")) return "image";
  if (contentType === "application/pdf") return "pdf";
  if (/\.(md|markdown)$/i.test(path) || contentType.startsWith("text/markdown")) return "markdown";
  if (contentType.startsWith("text/") || /json|xml|javascript|yaml/.test(contentType)) return "text";
  return "other";
}

export function FileIcon({ path, contentType, size = 15 }: { path: string; contentType: string; size?: number }) {
  const kind = kindOf(path, contentType);
  const Icon = kind === "image" ? FileImage : kind === "markdown" || kind === "pdf" ? FileText : kind === "text" ? FileCode : File;
  return <Icon size={size} className="flex-none text-muted" aria-hidden="true" />;
}

/** Files on a message, as chips that open the file in the project's files tab. */
export function AttachmentList({ attachments }: { attachments?: Attachment[] }) {
  const { go } = useProjectView();
  if (!attachments?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((a) => (
        <button
          type="button"
          key={a.path}
          onClick={() => go("files", { item: a.path })}
          className="flex max-w-[260px] items-center gap-2 rounded-lg border border-edge bg-raised px-2.5 py-1.5 text-left text-[13px] text-fg hover:bg-hover"
        >
          <FileIcon path={a.path} contentType={a.contentType} />
          <span className="truncate">{displayName(a.path)}</span>
          <span className="flex-none text-xs text-subtle">{formatSize(a.size)}</span>
        </button>
      ))}
    </div>
  );
}

/** Files picked in the composer, before sending. */
export function PendingAttachments({
  items,
  onRemove,
}: {
  items: { id: string; name: string; file?: ProjectFile; error?: string }[];
  onRemove: (id: string) => void;
}) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-2">
      {items.map((item) => (
        <span
          key={item.id}
          className={`flex max-w-[240px] items-center gap-2 rounded-lg border bg-panel py-1 pl-2.5 pr-1 text-[13px] ${
            item.error ? "border-bad/60 text-bad" : "border-edge"
          }`}
          title={item.error}
        >
          {item.file ? (
            <Paperclip size={13} className="flex-none text-muted" aria-hidden="true" />
          ) : !item.error ? (
            <LoaderCircle size={13} className="flex-none animate-spin text-muted" aria-hidden="true" />
          ) : null}
          <span className="truncate">{item.name}</span>
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            aria-label={t("files.remove", { name: item.name })}
            className="rounded p-0.5 text-subtle hover:bg-hover hover:text-fg"
          >
            <X size={13} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** A file's content, fetched with the API client so bearer-token apps can preview too. */
export function FilePreview({
  projectId,
  path,
  contentType,
  onClose,
}: {
  projectId: string;
  path: string;
  contentType?: string;
  onClose?: () => void;
}) {
  const t = useT();
  const blob = useQuery({
    queryKey: ["projects", projectId, "file", path],
    queryFn: () => api.getFile(projectId, path),
    staleTime: 5_000,
  });
  const type = contentType ?? blob.data?.type ?? "";
  const kind = kindOf(path, type);
  const url = useObjectUrl(blob.data);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    if (blob.data && (kind === "text" || kind === "markdown")) void blob.data.text().then(setText);
  }, [blob.data, kind]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 flex-none items-center gap-2 border-b border-line px-4">
        <FileIcon path={path} contentType={type} />
        <span className="min-w-0 flex-1 truncate font-medium" title={path}>
          {path}
        </span>
        {url && (
          <a
            href={url}
            download={displayName(path)}
            aria-label={t("files.download")}
            title={t("files.download")}
            className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
          >
            <Download size={16} />
          </a>
        )}
        {onClose && (
          <IconButton type="button" onClick={onClose} aria-label={t("files.closePreview")}>
            <X size={16} />
          </IconButton>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {blob.isPending && <p className="p-5 text-[13px] text-subtle">{t("files.loading")}</p>}
        {blob.isError && <p className="p-5 text-[13px] text-bad">{t("files.loadFailed")}</p>}
        {url && kind === "image" && <img src={url} alt={displayName(path)} className="mx-auto max-w-full p-5" />}
        {url && kind === "pdf" && <iframe src={url} title={path} className="size-full min-h-[70vh] bg-white" />}
        {text !== null && kind === "markdown" && (
          <div className="prose-altair p-5">
            <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
          </div>
        )}
        {text !== null && kind === "text" && (
          <pre className="whitespace-pre-wrap break-words p-5 font-mono text-[12.5px] text-body">{text}</pre>
        )}
        {blob.data && kind === "other" && (
          <p className="p-5 text-[13px] text-subtle">{t("files.noPreview")}</p>
        )}
      </div>
    </div>
  );
}

function useObjectUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return setUrl(null);
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}
