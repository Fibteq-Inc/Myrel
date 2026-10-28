import { useT } from "@myrel/i18n/react";
import { ApiError, codeLanguage } from "@myrel/client";
import type { Attachment, ProjectFile } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Download, File, FileCode, FileImage, FileText, LoaderCircle, Maximize2, Paperclip, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";
import { CodeTokens, lineClass, useCodeLines } from "../lib/highlight";
import { IconButton } from "../lib/ui";
import { ImageViewer } from "./image-viewer";
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

/**
 * Pictures by extension. Files stored before uploads were typed by their name can carry a form or
 * octet-stream type (an agent's `curl --data-binary`), so the name decides as well.
 */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
};

function imageType(path: string): string | undefined {
  return IMAGE_TYPES[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ""];
}

function kindOf(path: string, contentType: string): Kind {
  if (contentType.startsWith("image/") || imageType(path)) return "image";
  if (contentType === "application/pdf") return "pdf";
  if (/\.(md|markdown)$/i.test(path) || contentType.startsWith("text/markdown")) return "markdown";
  if (contentType.startsWith("text/") || /json|xml|javascript|yaml|sql/.test(contentType) || codeLanguage(path)) return "text";
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

type PendingItem = { id: string; name: string; file?: ProjectFile; error?: string };

/**
 * Files picked in the composer, before sending. With `onInline`, items that
 * `canInline` (a long paste turned into a file) offer to go back into the
 * message as text.
 */
export function PendingAttachments<T extends PendingItem>({
  items,
  onRemove,
  onInline,
  canInline,
}: {
  items: T[];
  onRemove: (id: string) => void;
  onInline?: (id: string) => void;
  canInline?: (item: T) => boolean;
}) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-2">
      {items.map((item) => (
        <span
          key={item.id}
          className={`flex max-w-[320px] items-center gap-2 rounded-lg border bg-panel py-1 pl-2.5 pr-1 text-[13px] ${
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
          {onInline && canInline?.(item) && (
            <button
              type="button"
              onClick={() => onInline(item.id)}
              className="flex-none rounded px-1 text-xs text-accent hover:bg-hover"
            >
              {t("composer.insertAsText")}
            </button>
          )}
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

/**
 * A file's content, fetched with the API client so bearer-token apps can preview too: a project
 * file, or with `local`, one in the project's folders on a computer (see api.getLocalFile).
 */
export function FilePreview({
  projectId,
  path,
  contentType,
  local,
  onClose,
}: {
  projectId: string;
  path: string;
  contentType?: string;
  local?: { threadId?: string };
  onClose?: () => void;
}) {
  const t = useT();
  const blob = useQuery({
    queryKey: local ? ["projects", projectId, "local-file", local.threadId ?? null, path] : ["projects", projectId, "file", path],
    queryFn: () => (local ? api.getLocalFile(projectId, path, local.threadId) : api.getFile(projectId, path)),
    staleTime: 5_000,
    retry: local ? false : undefined,
  });
  const type = contentType ?? blob.data?.type ?? "";
  const kind = kindOf(path, type);
  // A picture stored with another type still shows: the image gets its type from the name.
  const data = useMemo(() => {
    const type = blob.data && kind === "image" && !blob.data.type.startsWith("image/") ? imageType(path) : undefined;
    return type ? new Blob([blob.data!], { type }) : blob.data;
  }, [blob.data, kind, path]);
  const url = useObjectUrl(data);
  const [text, setText] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
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
        {text !== null && <CopyFileButton text={text} />}
        {url && kind === "image" && (
          <IconButton type="button" onClick={() => setFullscreen(true)} aria-label={t("files.openFullscreen")} title={t("files.openFullscreen")}>
            <Maximize2 size={16} />
          </IconButton>
        )}
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
        {blob.isError && (
          <p className="p-5 text-[13px] text-bad">
            {blob.error instanceof ApiError && blob.error.status !== 404 && blob.error.status < 500 ? blob.error.message : t("files.loadFailed")}
          </p>
        )}
        {url && kind === "image" && (
          <button type="button" onClick={() => setFullscreen(true)} title={t("files.openFullscreen")} className="block w-full cursor-zoom-in p-5">
            <img src={url} alt={displayName(path)} className="mx-auto max-w-full" />
          </button>
        )}
        {url && kind === "image" && fullscreen && <ImageViewer url={url} name={displayName(path)} onClose={() => setFullscreen(false)} />}
        {url && kind === "pdf" && <iframe src={url} title={path} className="size-full min-h-[70vh] bg-white" />}
        {text !== null && kind === "markdown" && (
          <div className="prose-myrel p-5">
            <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
          </div>
        )}
        {text !== null && kind === "text" && <TextView text={text} language={codeLanguage(path)} />}
        {blob.data && kind === "other" && (
          <p className="p-5 text-[13px] text-subtle">{t("files.noPreview")}</p>
        )}
      </div>
    </div>
  );
}

/** Past this many lines a code file is shown without line numbers, like other text. */
const CODE_LINE_LIMIT = 5_000;

/**
 * A text file: code (a known grammar) with syntax colors and line numbers, other text as it is.
 */
function TextView({ text, language }: { text: string; language?: string }) {
  const short = text.split("\n", CODE_LINE_LIMIT + 1).length <= CODE_LINE_LIMIT;
  const lines = useCodeLines(text, short ? language : undefined);
  if (!lines) return <pre className="whitespace-pre-wrap break-words p-5 font-mono text-[12.5px] text-body">{text}</pre>;
  const digits = String(lines.length).length;
  return (
    <pre className="py-4 font-mono text-[12.5px] leading-[1.6] text-body">
      {lines.map((line, i) => (
        <div key={i} className={`flex ${lineClass(line)}`}>
          <span
            aria-hidden="true"
            className="flex-none select-none pl-4 pr-4 text-right text-subtle"
            style={{ width: `${digits + 3}ch` }}
          >
            {i + 1}
          </span>
          <code className="min-h-[1.6em] min-w-0 flex-1 whitespace-pre-wrap break-words pr-5">
            <CodeTokens line={line} />
          </code>
        </div>
      ))}
    </pre>
  );
}

/** Past this, copying the whole file can stall the page and is rarely what people want; they download it. */
const COPY_LIMIT = 2 * 1024 * 1024;

/** Copies a text file's full content, not just what the preview shows. */
function CopyFileButton({ text }: { text: string }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "copied" | "failed" | "tooLarge">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), state === "copied" ? 1500 : 4000);
    return () => clearTimeout(timer);
  }, [state]);
  const message = state === "copied" ? t("common.copied") : state === "failed" ? t("files.copyFailed") : state === "tooLarge" ? t("files.copyTooLarge") : null;
  return (
    <>
      {message && (
        <span role="status" className={`min-w-0 truncate text-xs ${state === "copied" ? "text-ok" : "text-bad"}`} title={message}>
          {message}
        </span>
      )}
      <IconButton
        type="button"
        aria-label={t("files.copy")}
        title={t("files.copy")}
        onClick={async () => {
          if (text.length > COPY_LIMIT) return setState("tooLarge");
          try {
            await navigator.clipboard.writeText(text);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {state === "copied" ? <Check size={16} className="text-ok" /> : <Copy size={16} />}
      </IconButton>
    </>
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
