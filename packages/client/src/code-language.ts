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

/** Own keys only, so names like "constructor" do not hit Object.prototype. */
const own = (map: Record<string, string>, key: string) => (Object.hasOwn(map, key) ? map[key] : undefined);

/** The grammar for a file path, or undefined when it is not code we highlight. */
export function codeLanguage(path: string): string | undefined {
  const name = (path.split("/").at(-1) ?? path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return own(BY_NAME, name) ?? (dot > 0 ? own(BY_EXTENSION, name.slice(dot + 1)) : undefined);
}

const GRAMMARS = new Set([...Object.values(BY_EXTENSION), ...Object.values(BY_NAME)]);

/** Fence names that are neither a grammar nor an extension. */
const FENCE_ALIASES: Record<string, string> = {
  shell: "bash",
  console: "bash",
  shellsession: "bash",
  golang: "go",
  "c++": "cpp",
  "c#": "csharp",
  docker: "dockerfile",
  make: "makefile",
  postgresql: "sql",
  postgres: "sql",
  mysql: "sql",
  sqlite: "sql",
};

/** The grammar for a Markdown code fence's language (```sql, ```ts, ```shell), or undefined. */
export function fenceLanguage(name: string): string | undefined {
  const lang = name.toLowerCase();
  return GRAMMARS.has(lang) ? lang : (own(FENCE_ALIASES, lang) ?? own(BY_EXTENSION, lang));
}
