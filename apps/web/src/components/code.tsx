import { type Highlighter, loadHighlighter, type SyntaxKind } from "@myrel/client";
import { useEffect, useMemo, useState } from "react";

const COLORS: Record<SyntaxKind, string> = {
  comment: "text-syn-comment italic",
  keyword: "text-syn-keyword",
  string: "text-syn-string",
  number: "text-syn-number",
  title: "text-syn-title",
  type: "text-syn-type",
  attr: "text-syn-attr",
  meta: "text-syn-meta",
  added: "text-syn-added",
  removed: "text-syn-removed",
};

/** The highlighter once loaded (it is fetched the first time code is shown), else null. */
function useHighlighter(): Highlighter | null {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);
  useEffect(() => {
    let live = true;
    void loadHighlighter().then((h) => live && setHighlighter(h));
    return () => {
      live = false;
    };
  }, []);
  return highlighter;
}

/**
 * Code colored by its language: a code block's tag (`sql`) or a file's path. Plain until the
 * highlighter loads, and for languages it does not know.
 */
export function HighlightedCode({ code, language }: { code: string; language?: string }) {
  const highlighter = useHighlighter();
  const tokens = useMemo(() => {
    const lang = highlighter?.language(language);
    return lang ? highlighter!.highlight(code, lang) : null;
  }, [highlighter, code, language]);
  if (!tokens) return <code>{code}</code>;
  return (
    <code>
      {tokens.map((t, i) =>
        t.kind ? (
          <span key={i} className={COLORS[t.kind]}>
            {t.text}
          </span>
        ) : (
          t.text
        ),
      )}
    </code>
  );
}
