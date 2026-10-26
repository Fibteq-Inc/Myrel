import { idPattern } from "./ids";
import { normalizeFilePath } from "./paths";

const THREAD_ID = new RegExp(idPattern("thread").source.slice(1, -1));
const THREAD_HREF = new RegExp(`^#(${THREAD_ID.source})$`);

/**
 * A Markdown link to a thread, as agents write it in messages: `[Title](#thr_…)`.
 * Clients draw it as a link that opens the thread.
 */
export function threadLink(thread: { id: string; title: string }): string {
  return `[${thread.title.replace(/[[\]]/g, "")}](#${thread.id})`;
}

/** The thread id a message link points at, or null when it is not a thread link. */
export function threadIdFromHref(href: string | undefined): string | null {
  return (href && THREAD_HREF.exec(href)?.[1]) || null;
}

/**
 * A file an agent's message points to, by link or inline code: a project file anyone in the project
 * can open, a file in the project's folders on the computer of whoever is viewing (`local`), or one
 * on someone else's computer (`elsewhere`), which only that person can open.
 */
export type FileRef = { kind: "project" | "local" | "elsewhere"; path: string };

export type FileRefContext = {
  /** Paths of the project's files. */
  projectFiles: ReadonlySet<string>;
  /** Whether the project has a local folder, and if so whether it is on the viewer's computer. */
  workspace: "mine" | "other" | null;
};

/** A path without what editors and agents add: file://, %-escapes, :line:col and #L anchors. */
export function cleanFileRef(ref: string): string {
  let p = ref.trim();
  if (p.startsWith("file://")) p = p.slice("file://".length);
  try {
    p = decodeURIComponent(p);
  } catch {
    // Not escaped.
  }
  return p.replace(/#L\d+(-L?\d+)?$/, "").replace(/(:\d+){1,2}$/, "");
}

/** A link that is a file path rather than a web address: no scheme (or file://), not an anchor or app route. */
export function isLocalHref(href: string): boolean {
  if (href.startsWith("file://")) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || /^(#|\?|\/\/|\/api\/|\/projects\/)/.test(href)) return false;
  return /[\w.-]/.test(href);
}

/** Inline code that could name a file: one word ending in an extension (`rapor.md`, `src/a.ts:12`). */
export function mayBeFileName(code: string): boolean {
  const p = cleanFileRef(code);
  return p.length <= 512 && !/[\s"'`<>|*?{}()[\]$;,=]/.test(p) && !/^[a-z][a-z0-9+.-]*:/i.test(p) && /[^/]\.[a-z0-9_-]*[a-z][a-z0-9_-]*$/i.test(p);
}

/**
 * Inline code that clearly is a path on a computer, not a bare word: absolute, `./`-relative, or
 * folders and a file name (`apps/web/x.tsx`). A first folder that looks like a host (github.com/…)
 * is taken for a web address.
 */
function isPathLike(code: string): boolean {
  if (!mayBeFileName(code)) return false;
  const p = cleanFileRef(code);
  if (p.startsWith("/") || p.startsWith("./") || p.startsWith("../")) return true;
  const [first, ...rest] = p.split("/");
  return rest.length > 0 && !/^[^.].*\.[a-z]{2,}$/i.test(first!);
}

/** What a message link points to, or null when it is a web address or nothing can open it. */
export function resolveFileHref(href: string | undefined, ctx: FileRefContext): FileRef | null {
  if (!href || !isLocalHref(href)) return null;
  return resolve(href, ctx, true);
}

/** What a piece of inline code points to, or null when it is just code. */
export function resolveFileCode(code: string, ctx: FileRefContext): FileRef | null {
  if (!mayBeFileName(code)) return null;
  return resolve(code, ctx, isPathLike(code));
}

function resolve(ref: string, ctx: FileRefContext, local: boolean): FileRef | null {
  const path = cleanFileRef(ref);
  const project = normalizeFilePath(path);
  if (ctx.projectFiles.has(project)) return { kind: "project", path: project };
  if (!local || !ctx.workspace) return null;
  return { kind: ctx.workspace === "mine" ? "local" : "elsewhere", path };
}

/**
 * Plain text cut around the project files' paths it names, so a path an agent wrote without a link
 * or code (`Kanıt: notes/sonuc.json`) still opens the file. Only exact project file paths count;
 * punctuation and a Turkish suffix after one (`rapor.md'yi`, `sonuc.json.`) stay text.
 */
export function splitFilePaths(text: string, projectFiles: ReadonlySet<string>): Array<string | { text: string; path: string }> {
  if (projectFiles.size === 0 || !text.includes(".")) return [text];
  const parts: Array<string | { text: string; path: string }> = [];
  let last = 0;
  for (const match of text.matchAll(/[^\s"'`<>()[\]{}|*]+/g)) {
    const word = match[0].replace(/[.,;:!?…]+$/, "");
    if (!mayBeFileName(word)) continue;
    const path = normalizeFilePath(word);
    if (!projectFiles.has(path)) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ text: word, path });
    last = match.index + word.length;
  }
  if (last === 0) return [text];
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
