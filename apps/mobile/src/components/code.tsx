import { type Highlighter, loadHighlighter, type SyntaxKind } from "@myrel/client";
import { useEffect, useMemo, useState } from "react";
import { Text, type TextStyle } from "react-native";
import { type Colors, useColors } from "../theme";

const COLORS: Record<SyntaxKind, keyof Colors> = {
  comment: "synComment",
  keyword: "synKeyword",
  string: "synString",
  number: "synNumber",
  title: "synTitle",
  type: "synType",
  attr: "synAttr",
  meta: "synMeta",
  added: "synAdded",
  removed: "synRemoved",
};

/** The highlighter once loaded (it is loaded the first time code is shown), else null. */
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
export function HighlightedCode({ code, language, style }: { code: string; language?: string; style?: TextStyle | TextStyle[] }) {
  const colors = useColors();
  const highlighter = useHighlighter();
  const tokens = useMemo(() => {
    const lang = highlighter?.language(language);
    return lang ? highlighter!.highlight(code, lang) : null;
  }, [highlighter, code, language]);
  return (
    <Text selectable style={style}>
      {tokens
        ? tokens.map((t, i) =>
            t.kind ? (
              <Text key={i} style={{ color: colors[COLORS[t.kind]], fontStyle: t.kind === "comment" ? "italic" : "normal" }}>
                {t.text}
              </Text>
            ) : (
              t.text
            ),
          )
        : code}
    </Text>
  );
}
