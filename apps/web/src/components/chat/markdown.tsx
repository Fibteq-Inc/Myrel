import { useT } from "@altair/i18n/react";
import { DECISION_LANG, parseDecision } from "@altair/protocol";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
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
  const components: Components = {
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
      const text = String(children ?? "");
      // Inline code has no language and no newline.
      if (!lang && !text.includes("\n")) return <code>{children}</code>;
      if (lang === DECISION_LANG) {
        const parsed = parseDecision(text);
        if (parsed) return <DecisionCard decision={parsed} answer={decision?.answer} onChoose={decision?.onChoose} />;
      }
      return <CodeBlock lang={lang}>{text.replace(/\n$/, "")}</CodeBlock>;
    },
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
  };
  return (
    <div className="prose-altair">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </Markdown>
    </div>
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
