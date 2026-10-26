/**
 * Which highlight.js grammar a file is drawn with (see ./highlight), by its extension or name.
 * Kept apart from the grammars so a file's kind is known without loading them.
 */
const BY_EXTENSION: Record<string, string> = {
  sql: "sql",
  json: "json",
  jsonc: "json",
  geojson: "json",
  yaml: "yaml",
  yml: "yaml",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  diff: "diff",
  patch: "diff",
  css: "css",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  toml: "ini",
  ini: "ini",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
};

const BY_NAME: Record<string, string> = { dockerfile: "dockerfile", makefile: "makefile" };

/** The grammar for a file path, or undefined when it is not code we highlight. */
export function codeLanguage(path: string): string | undefined {
  const name = (path.split("/").at(-1) ?? path).toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1)] : undefined;
}
