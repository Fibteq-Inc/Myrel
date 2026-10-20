import { useT } from "@myrel/i18n/react";
import { DECISION_LANG, parseDecision, threadIdFromHref } from "@myrel/protocol";
import { Link, useParams } from "@tanstack/react-router";
import { Check, Copy, MessagesSquare } from "lucide-react";
import { memo, type ReactNode, useCallback, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
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
  const { projectId } = useParams({ strict: false });
  const components: Components = {
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
      const text = String(children ?? "");
      // Inline code has no language and no newline.
      if (!lang && !text.includes("\n")) return <code>{children}</code>;
      if (lang === DECISION_LANG) {
        const parsed = parseDecision(text);
        if (parsed) return <DecisionCard decision={parsed} answer={answer} onChoose={onChoose} />;
      }
      return <CodeBlock lang={lang}>{text.replace(/\n$/, "")}</CodeBlock>;
    },
    a: ({ href, children }) => {
      // [Title](#thr_…) opens that thread's panel.
      const threadId = threadIdFromHref(href);
      if (threadId && projectId) return <ThreadLink projectId={projectId} threadId={threadId}>{children}</ThreadLink>;
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
