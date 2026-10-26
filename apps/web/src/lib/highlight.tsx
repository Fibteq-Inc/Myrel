import type { CodeLine, TokenKind } from "@myrel/client/highlight";
import { useEffect, useMemo, useState } from "react";

type Highlighter = typeof import("@myrel/client/highlight");

/** The grammars load on first use so they stay out of the main bundle; after that, coloring is synchronous. */
let loaded: Highlighter | undefined;
let loading: Promise<Highlighter> | undefined;
const load = () => (loading ??= import("@myrel/client/highlight").then((m) => (loaded = m)));

/**
 * The text as lines of colored tokens in `language` (a grammar from codeLanguage/fenceLanguage),
 * or null with no grammar, or while the grammars load the first time.
 */
export function useCodeLines(text: string, language?: string): CodeLine[] | null {
  const [ready, setReady] = useState(loaded !== undefined);
  useEffect(() => {
    if (!language || loaded) return;
    let live = true;
    void load().then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [language]);
  return useMemo(() => (language && ready && loaded ? loaded.highlightLines(text, language) : null), [text, language, ready]);
}

const TOKEN_CLASS: Record<TokenKind, string> = {
  keyword: "text-accent",
  string: "text-ok",
  number: "text-warn",
  comment: "italic text-subtle",
  name: "text-link",
  type: "text-merged",
  meta: "text-muted",
  addition: "text-ok",
  deletion: "text-bad",
};

/** Diff lines get a tinted background as well as their color. */
export function lineClass(line: CodeLine) {
  const kind = line[0]?.kind;
  return kind === "addition" ? "bg-ok-soft" : kind === "deletion" ? "bg-bad-soft" : "";
}

/** One line's tokens, each in its theme color. */
export function CodeTokens({ line }: { line: CodeLine }) {
  return line.map((token, i) =>
    token.kind ? (
      <span key={i} className={TOKEN_CLASS[token.kind]}>
        {token.text}
      </span>
    ) : (
      token.text
    ),
  );
}
