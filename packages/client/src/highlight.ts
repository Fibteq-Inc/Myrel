import type { Element, ElementContent, Root } from "hast";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import makefile from "highlight.js/lib/languages/makefile";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";

/**
 * Syntax highlighting for file previews, shared by web and mobile: the text comes back as lines
 * of tokens with a small set of kinds, and each app draws a kind in its own theme's colors.
 * Only the grammars named in ./code-language are loaded, so this stays a light import.
 */
const lowlight = createLowlight({
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  makefile,
  php,
  python,
  ruby,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
});

export type TokenKind = "keyword" | "string" | "number" | "comment" | "name" | "type" | "meta" | "addition" | "deletion";
export type CodeToken = { text: string; kind?: TokenKind };
export type CodeLine = CodeToken[];

/** highlight.js scopes folded into the kinds a theme colors. */
const KINDS: Record<string, TokenKind> = {
  keyword: "keyword",
  "selector-tag": "keyword",
  doctag: "keyword",
  name: "keyword",
  string: "string",
  regexp: "string",
  char: "string",
  number: "number",
  literal: "number",
  symbol: "number",
  bullet: "number",
  comment: "comment",
  quote: "comment",
  title: "name",
  section: "name",
  attr: "name",
  attribute: "name",
  property: "name",
  "selector-id": "name",
  "selector-class": "name",
  "template-variable": "name",
  variable: "name",
  type: "type",
  built_in: "type",
  meta: "meta",
  tag: "meta",
  addition: "addition",
  deletion: "deletion",
};

/** Past this the file is shown as plain lines: highlighting it would stall the screen. */
export const HIGHLIGHT_LIMIT = 200_000;

function kindOf(node: Element, inherited?: TokenKind): TokenKind | undefined {
  const names = node.properties.className;
  if (!Array.isArray(names)) return inherited;
  for (const name of names) {
    const scope = String(name).replace(/^hljs-/, "");
    const kind = Object.hasOwn(KINDS, scope) ? KINDS[scope] : undefined;
    if (kind) return kind;
  }
  return inherited;
}

/**
 * The text split into lines of tokens, colored as `language` (a grammar from codeLanguage).
 * Unknown grammars, or text past HIGHLIGHT_LIMIT, come back as plain lines.
 */
export function highlightLines(text: string, language?: string): CodeLine[] {
  const lines: CodeLine[] = [[]];
  const push = (value: string, kind?: TokenKind) => {
    const parts = value.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (!part) return;
      const line = lines.at(-1)!;
      const last = line.at(-1);
      if (last && last.kind === kind) last.text += part;
      else line.push(kind ? { text: part, kind } : { text: part });
    });
  };
  const walk = (nodes: ElementContent[], kind?: TokenKind) => {
    for (const node of nodes) {
      if (node.type === "text") push(node.value, kind);
      else if (node.type === "element") walk(node.children, kindOf(node, kind));
    }
  };
  let tree: Root | undefined;
  if (language && text.length <= HIGHLIGHT_LIMIT && lowlight.registered(language)) {
    try {
      tree = lowlight.highlight(language, text);
    } catch {
      tree = undefined;
    }
  }
  if (tree) walk(tree.children as ElementContent[]);
  else push(text);
  // A file's closing newline is not a line of its own.
  if (lines.length > 1 && lines.at(-1)!.length === 0) lines.pop();
  return lines;
}
