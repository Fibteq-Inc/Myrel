import { type GithubEnv, githubFetch } from "./app";
import { projectRepoToken } from "./store";

type ContentItem = { type: "file" | "dir" | "symlink" | "submodule"; name: string; path: string; size: number };
type FileContent = ContentItem & { encoding?: string; content?: string };

/** Longest file text handed to the model in one read. */
const MAX_FILE_CHARS = 60_000;

type FilesEnv = GithubEnv & { DB: D1Database };

function contentsPath(fullName: string, path: string, ref?: string) {
  const clean = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/repos/${fullName}/contents/${clean}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
}

/** One line per entry, directories first, for the thread agent's repo_list_files tool. */
export async function listRepoFiles(env: FilesEnv, projectId: string, repo: string, path: string, ref?: string) {
  const { token, repo: r } = await projectRepoToken(env, projectId, repo);
  const res = await githubFetch<ContentItem[] | ContentItem>(token, contentsPath(r.fullName, path, ref));
  if (!Array.isArray(res)) return `${res.path} is a ${res.type}, not a directory. Read it with repo_read_file.`;
  const sorted = [...res].sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
  const lines = sorted.map((e) => (e.type === "dir" ? `${e.path}/` : `${e.path} (${e.size} bytes)`));
  return lines.join("\n") || "(empty directory)";
}

/** A file's text, cut at MAX_FILE_CHARS, for the thread agent's repo_read_file tool. */
export async function readRepoFile(env: FilesEnv, projectId: string, repo: string, path: string, ref?: string) {
  const { token, repo: r } = await projectRepoToken(env, projectId, repo);
  const res = await githubFetch<FileContent[] | FileContent>(token, contentsPath(r.fullName, path, ref));
  if (Array.isArray(res)) return `${path} is a directory. List it with repo_list_files.`;
  if (res.type !== "file") return `${res.path} is a ${res.type}.`;
  // GitHub omits the content of files over 1 MB.
  if (res.encoding !== "base64" || res.content === undefined) return `${res.path} is too large to read (${res.size} bytes).`;
  const bytes = Uint8Array.from(atob(res.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
  if (bytes.subarray(0, 8000).includes(0)) return `${res.path} is a binary file (${res.size} bytes).`;
  const text = new TextDecoder().decode(bytes);
  return text.length > MAX_FILE_CHARS
    ? `${text.slice(0, MAX_FILE_CHARS)}\n\n[truncated: showing ${MAX_FILE_CHARS} of ${text.length} characters]`
    : text;
}
