/**
 * Syntax colors for code blocks in messages and text files in previews, on web and mobile alike.
 * highlight.js (through lowlight, which gives a tree instead of HTML) is loaded on first use, so
 * the app does not carry it until someone looks at code. Its many token classes are folded into a
 * few kinds that each app colors from its theme tokens.
 */
export type SyntaxKind = "comment" | "keyword" | "string" | "number" | "title" | "type" | "attr" | "meta" | "added" | "removed";

/** A run of code text and its kind; null is plain text. */
export type SyntaxToken = { text: string; kind: SyntaxKind | null };

export type Highlighter = {
  /** The language for a code block's tag (`sql`, `ts`) or a file's path, or null when it has none. */
  language(tagOrPath: string | undefined): string | null;
  /** The code cut into colored runs, or null when it is too long to color quickly. */
  highlight(code: string, language: string): SyntaxToken[] | null;
};

/** Past this, coloring could stall the screen; the code is shown plain. */
const MAX_CODE = 100_000;

const KINDS: Record<string, SyntaxKind> = {
  comment: "comment",
  quote: "comment",
  doctag: "comment",
  keyword: "keyword",
  "selector-tag": "keyword",
  string: "string",
  regexp: "string",
  symbol: "string",
  char: "string",
  link: "string",
  number: "number",
  literal: "number",
  title: "title",
  section: "title",
  name: "title",
  type: "type",
  built_in: "type",
  class_: "type",
  attr: "attr",
  attribute: "attr",
  property: "attr",
  variable: "attr",
  "template-variable": "attr",
  "selector-class": "attr",
  "selector-id": "attr",
  "selector-attr": "attr",
  meta: "meta",
  addition: "added",
  deletion: "removed",
};

/** File names that say their language without an extension. */
const FILE_NAMES: Record<string, string> = { makefile: "makefile", gnumakefile: "makefile" };

type Node = { type: string; value?: string; properties?: { className?: unknown }; children?: Node[] };

function kindOf(node: Node): SyntaxKind | null {
  const classes = Array.isArray(node.properties?.className) ? (node.properties.className as string[]) : [];
  // "hljs-title function_" or "hljs-title class_": the more specific class wins.
  let kind: SyntaxKind | null = null;
  for (const c of classes) kind = KINDS[c.replace(/^hljs-/, "")] ?? kind;
  return kind;
}

function flatten(nodes: Node[], kind: SyntaxKind | null, out: SyntaxToken[]) {
  for (const node of nodes) {
    if (node.type === "text") {
      const last = out.at(-1);
      if (last && last.kind === kind) last.text += node.value ?? "";
      else out.push({ text: node.value ?? "", kind });
    } else if (node.children) flatten(node.children, kindOf(node) ?? kind, out);
  }
}

let loading: Promise<Highlighter> | undefined;

/** The highlighter, loaded once. */
export function loadHighlighter(): Promise<Highlighter> {
  loading ??= import("./lowlight").then(({ lowlight }) => {
    return {
      language(tagOrPath) {
        if (!tagOrPath) return null;
        const name = tagOrPath.split("/").at(-1)!.toLowerCase();
        const tag = FILE_NAMES[name] ?? (name.includes(".") ? name.split(".").at(-1)! : name);
        return tag && lowlight.registered(tag) ? tag : null;
      },
      highlight(code, language) {
        if (code.length > MAX_CODE) return null;
        const out: SyntaxToken[] = [];
        flatten(lowlight.highlight(language, code).children as Node[], null, out);
        return out;
      },
    };
  });
  return loading;
}
