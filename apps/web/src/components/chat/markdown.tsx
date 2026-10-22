import { useT } from "@myrel/i18n/react";
import {
  DECISION_LANG,
  type FileRef,
  type FileRefContext,
  isLocalHref,
  mayBeFileName,
  parseDecision,
  resolveFileCode,
  resolveFileHref,
  threadIdFromHref,
} from "@myrel/protocol";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, FileText, MessagesSquare, MonitorSmartphone } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { filesQuery, runnersQuery, workspaceQuery } from "../../lib/api";
import { FilePreview } from "../files";
import { DecisionCard } from "./decision-card";

export type DecisionHandlers = {
  /** The reply that answered this message's decision, if any. */
  answer?: string;
  onChoose?: (label: string) => void;
};

/** An agent message body: GitHub-flavored Markdown, code blocks with a copy button, decision cards. */
export function MessageMarkdown({ body, decision }: { body: string; decision?: DecisionHandlers }) {
  // Parsing Markdown is the costly part of drawing a message; the body is parsed again only when it
  // (or its decision's answer) changes, however often the conversation around it redraws.
  const latest = useRef(decision?.onChoose);
  latest.current = decision?.onChoose;
  const onChoose = useCallback((label: string) => latest.current?.(label), []);
  return <MarkdownBody body={body} answer={decision?.answer} onChoose={decision?.onChoose ? onChoose : undefined} />;
}

const MarkdownBody = memo(function MarkdownBody({
  body,
  answer,
  onChoose,
}: {
  body: string;
  answer?: string;
  onChoose?: (label: string) => void;
}) {
  const { projectId, threadId } = useParams({ strict: false });
  const components: Components = {
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
      const text = String(children ?? "");
      // Inline code has no language and no newline. A file's path in it opens the file.
      if (!lang && !text.includes("\n")) {
        if (projectId && mayBeFileName(text)) return <FileCode projectId={projectId} threadId={threadId} code={text} />;
        return <code>{children}</code>;
      }
      if (lang === DECISION_LANG) {
        const parsed = parseDecision(text);
        if (parsed) return <DecisionCard decision={parsed} answer={answer} onChoose={onChoose} />;
      }
      return <CodeBlock lang={lang}>{text.replace(/\n$/, "")}</CodeBlock>;
    },
    a: ({ href, children }) => {
      // [Title](#thr_…) opens that thread's panel.
      const linked = threadIdFromHref(href);
      if (linked && projectId) return <ThreadLink projectId={projectId} threadId={linked}>{children}</ThreadLink>;
      // A file: in the project's files, or one the agent wrote in the project's folders on a computer (DURUM.md, /Users/…/notes.md).
      if (href && projectId && isLocalHref(href)) {
        return (
          <FileLink projectId={projectId} threadId={threadId} href={href}>
            {children}
          </FileLink>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
  };
  return (
    <div className="prose-myrel">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </Markdown>
    </div>
  );
});

/** What file paths in this project's messages can open: its files, and its local folder if it has one. */
function useFileRefContext(projectId: string): FileRefContext {
  const files = useQuery({ ...filesQuery(projectId), staleTime: 30_000 });
  const workspace = useQuery(workspaceQuery(projectId));
  const runners = useQuery({ ...runnersQuery, enabled: !!workspace.data });
  const runnerId = workspace.data?.runnerId;
  const mine = !!runnerId && !!runners.data?.some((r) => r.id === runnerId);
  const projectFiles = useMemo(() => new Set(files.data?.map((f) => f.path)), [files.data]);
  return { projectFiles, workspace: runnerId ? (mine ? "mine" : "other") : null };
}

/** A link to a path: a file chip when it can be opened, otherwise an ordinary link. */
function FileLink({ projectId, threadId, href, children }: { projectId: string; threadId?: string; href: string; children: ReactNode }) {
  const file = resolveFileHref(href, useFileRefContext(projectId));
  if (!file) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  return (
    <FileChip projectId={projectId} threadId={threadId} file={file}>
      {children}
    </FileChip>
  );
}

/** Inline code naming a file: a file chip when it can be opened, otherwise just code. */
function FileCode({ projectId, threadId, code }: { projectId: string; threadId?: string; code: string }) {
  const file = resolveFileCode(code, useFileRefContext(projectId));
  if (!file) return <code>{code}</code>;
  return (
    <FileChip projectId={projectId} threadId={threadId} file={file}>
      <code className="bg-transparent p-0">{code}</code>
    </FileChip>
  );
}

/** Opens a file in a preview: a project file, or one read from the computer the project's folder is on. */
function FileChip({ projectId, threadId, file, children }: { projectId: string; threadId?: string; file: FileRef; children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const elsewhere = file.kind === "elsewhere";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={elsewhere ? t("files.onOtherComputer") : file.path}
        className={`inline-flex items-baseline gap-1 rounded-md border border-line bg-raised px-1.5 font-medium transition-colors hover:border-edge ${elsewhere ? "text-muted" : "text-fg"}`}
      >
        {elsewhere ? (
          <MonitorSmartphone size={13} className="flex-none self-center text-subtle" aria-hidden="true" />
        ) : (
          <FileText size={13} className="flex-none self-center text-subtle" aria-hidden="true" />
        )}
        {children}
      </button>
      {/* In a portal: the link sits inside a paragraph, which cannot hold the preview's blocks. */}
      {open && createPortal(<FileDialog projectId={projectId} threadId={threadId} file={file} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function FileDialog({ projectId, threadId, file, onClose }: { projectId: string; threadId?: string; file: FileRef; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  const elsewhere = file.kind === "elsewhere";
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className={`m-auto open:flex w-[min(860px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-line bg-ground p-0 text-[13px] text-fg shadow-2xl backdrop:bg-black/60 ${elsewhere ? "" : "h-[min(80vh,900px)]"}`}
    >
      {elsewhere ? (
        <div className="flex flex-col gap-3 p-5">
          <p className="truncate font-mono text-[12.5px] text-muted" title={file.path}>
            {file.path}
          </p>
          <p className="text-body">{t("files.onOtherComputerBody")}</p>
          <button type="button" onClick={onClose} className="self-end rounded-lg border border-edge px-3 py-1.5 hover:bg-hover">
            {t("common.close")}
          </button>
        </div>
      ) : (
        <FilePreview projectId={projectId} path={file.path} local={file.kind === "local" ? { threadId } : undefined} onClose={onClose} />
      )}
    </dialog>
  );
}

function ThreadLink({ projectId, threadId, children }: { projectId: string; threadId: string; children: ReactNode }) {
  return (
    <Link
      to="/projects/$projectId/threads/$threadId"
      params={{ projectId, threadId }}
      className="inline-flex items-baseline gap-1 rounded-md border border-line bg-raised px-1.5 font-medium text-fg no-underline transition-colors hover:border-edge"
    >
      <MessagesSquare size={13} className="flex-none self-center text-subtle" aria-hidden="true" />
      {children}
    </Link>
  );
}

function CodeBlock({ lang, children }: { lang?: string; children: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-rail">
      <div className="flex h-8 items-center border-b border-line pl-3 pr-1 font-mono text-[11px] text-subtle">
        {lang ?? "text"}
        <CopyButton text={children} className="ml-auto" />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-body">
        <code>{children}</code>
      </pre>
    </div>
  );
}

export function CopyButton({ text, className = "", label }: { text: string; className?: string; label?: string }): ReactNode {
  const t = useT();
  const [copied, setCopied] = useState(false);
  label ??= t("common.copy");
  return (
    <button
      type="button"
      aria-label={copied ? t("common.copied") : label}
      title={copied ? t("common.copied") : label}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={`flex size-7 items-center justify-center rounded-md text-subtle hover:bg-hover hover:text-fg ${className}`}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}
