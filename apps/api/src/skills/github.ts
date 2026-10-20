import { parseSkillMd, SKILL_LIMITS } from "@myrel/protocol";
import type { SkillFiles } from "./store";

/** A GitHub location of one or more skills. */
export type GithubSource = { owner: string; repo: string; ref?: string; path: string; skill?: string };

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Reads where to take skills from: "owner/repo", "owner/repo/path/to/skill", a github.com link
 * (…/tree/<ref>/<path>, the ref being one path segment), or a skills.sh link (skills.sh/<owner>/<repo>/<skill>).
 */
export function parseGithubSource(input: string): GithubSource | null {
  let text = input.trim().replace(/\.git$/, "");
  let fromSkillsSh = false;
  const url = /^https?:\/\//i.test(text) ? safeUrl(text) : null;
  if (url) {
    const host = url.hostname.replace(/^www\./, "");
    if (host === "skills.sh") fromSkillsSh = true;
    else if (host !== "github.com") return null;
    text = url.pathname.replace(/^\/+|\/+$/g, "");
  } else {
    text = text.replace(/^github\.com\//i, "");
  }
  const parts = text.split("/").filter(Boolean).map(decodeURIComponent);
  const [owner, repo, ...rest] = parts;
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return null;
  if (fromSkillsSh) return { owner, repo, path: "", ...(rest[0] && { skill: rest[0] }) };
  if (url && (rest[0] === "tree" || rest[0] === "blob") && rest[1]) {
    const path = rest.slice(2).join("/").replace(/\/?SKILL\.md$/, "");
    return { owner, repo, ref: rest[1], path };
  }
  if (rest.some((p) => p === ".." || p === ".")) return null;
  return { owner, repo, path: rest.join("/").replace(/\/?SKILL\.md$/, "") };
}

function safeUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** A skill found in a repository. */
export type FoundSkill = { name: string; description: string; path: string; files: SkillFiles };

export type GithubImport =
  | { ok: true; commit: string; skills: FoundSkill[] }
  | { ok: false; status: 400 | 404 | 413 | 502; error: string };

/** Files kept from one download at most, so a large repository cannot exhaust the Worker. */
const MAX_KEPT_BYTES = 24 * 1024 * 1024;
/** Folders never searched for skills. */
const SKIP = /(^|\/)(node_modules|\.git)(\/|$)/;

/**
 * Downloads a public repository at one commit and finds the skills in it (every folder with a
 * SKILL.md, under `source.path` when given). The commit is pinned, so the same skill comes back
 * until someone updates it.
 */
export async function importFromGithub(source: GithubSource, fetcher: typeof fetch = fetch): Promise<GithubImport> {
  const commit = await resolveCommit(source, fetcher);
  if (!commit.ok) return commit;
  const res = await fetcher(`https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${commit.sha}`);
  if (!res.ok || !res.body) {
    return { ok: false, status: res.status === 404 ? 404 : 502, error: `Could not download ${source.owner}/${source.repo} (${res.status}).` };
  }
  const prefix = source.path ? `${source.path.replace(/^\/+|\/+$/g, "")}/` : "";
  const kept = new Map<string, Uint8Array>();
  let keptBytes = 0;
  try {
    for await (const entry of readTar(res.body.pipeThrough(new DecompressionStream("gzip")))) {
      // Every path starts with the archive's top folder (<repo>-<commit>/).
      const path = entry.path.slice(entry.path.indexOf("/") + 1);
      if (!path || !path.startsWith(prefix) || SKIP.test(path) || entry.size > SKILL_LIMITS.fileBytes) {
        await entry.skip();
        continue;
      }
      keptBytes += entry.size;
      if (keptBytes > MAX_KEPT_BYTES) {
        return { ok: false, status: 413, error: "That repository is too large to search. Link the skill's own folder instead." };
      }
      kept.set(path, await entry.bytes());
    }
  } catch (err) {
    return { ok: false, status: 502, error: `Could not read ${source.owner}/${source.repo}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const dirs = [...kept.keys()].filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md")).map((p) => p.slice(0, -"SKILL.md".length).replace(/\/$/, ""));
  const skills: FoundSkill[] = dirs.map((dir) => {
    const front = parseSkillMd(new TextDecoder().decode(kept.get(dir ? `${dir}/SKILL.md` : "SKILL.md")));
    const within = dir ? `${dir}/` : "";
    // A skill's files are its folder's, except those of another skill inside it.
    const nested = dirs.filter((d) => d !== dir && d.startsWith(within));
    const files: SkillFiles = new Map();
    for (const [path, bytes] of kept) {
      if (!path.startsWith(within) || nested.some((d) => path.startsWith(`${d}/`))) continue;
      files.set(path.slice(within.length), bytes);
    }
    const folder = dir.split("/").pop() || source.repo;
    return { name: front.name ?? folder.toLowerCase(), description: front.description ?? "", path: dir, files };
  });
  if (!skills.length) {
    return { ok: false, status: 404, error: `No SKILL.md found in ${source.owner}/${source.repo}${source.path ? `/${source.path}` : ""}.` };
  }
  return { ok: true, commit: commit.sha, skills };
}

/** Picks the skill asked for among those found: by name or folder name, or the only one. */
export function pickSkill(found: FoundSkill[], wanted?: string): FoundSkill | null {
  if (wanted) {
    const w = wanted.toLowerCase();
    return found.find((s) => s.name === w) ?? found.find((s) => s.path.split("/").pop()?.toLowerCase() === w) ?? null;
  }
  return found.length === 1 ? found[0]! : null;
}

/**
 * The commit a branch, tag or the default branch points to, from git's own ref listing (no
 * GitHub API, so no API rate limit). A full commit hash is taken as is.
 */
async function resolveCommit(
  source: GithubSource,
  fetcher: typeof fetch,
): Promise<{ ok: true; sha: string } | { ok: false; status: 400 | 404 | 502; error: string }> {
  if (source.ref && /^[0-9a-f]{40}$/i.test(source.ref)) return { ok: true, sha: source.ref.toLowerCase() };
  const res = await fetcher(`https://github.com/${source.owner}/${source.repo}.git/info/refs?service=git-upload-pack`, {
    headers: { "user-agent": "myrel" },
  });
  if (res.status === 401 || res.status === 404) {
    return { ok: false, status: 404, error: `${source.owner}/${source.repo} was not found, or it is private. Only public repositories can be added.` };
  }
  if (!res.ok) return { ok: false, status: 502, error: `GitHub answered ${res.status}.` };
  const refs = parseRefs(await res.text());
  const sha = source.ref
    ? (refs.get(`refs/tags/${source.ref}^{}`) ?? refs.get(`refs/tags/${source.ref}`) ?? refs.get(`refs/heads/${source.ref}`))
    : refs.get("HEAD");
  if (!sha) return { ok: false, status: 404, error: source.ref ? `No branch or tag named ${source.ref}.` : "The repository is empty." };
  return { ok: true, sha };
}

/** Ref → commit from a smart HTTP ref advertisement (pkt-lines). */
export function parseRefs(text: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const m = /([0-9a-f]{40}) ([^\0\s]+)/.exec(raw);
    if (m) refs.set(m[2]!, m[1]!);
  }
  return refs;
}

type TarEntry = { path: string; size: number; bytes(): Promise<Uint8Array>; skip(): Promise<void> };

/**
 * The regular files of a tar stream (ustar, with pax and GNU long names), one at a time. Each
 * entry must be read or skipped before the next.
 */
export async function* readTar(stream: ReadableStream<Uint8Array>): AsyncGenerator<TarEntry> {
  const reader = stream.getReader();
  let buffer: Uint8Array = new Uint8Array(0);
  let done = false;
  const need = async (n: number) => {
    while (buffer.length < n && !done) {
      const chunk = await reader.read();
      if (chunk.done) done = true;
      else buffer = concat(buffer, chunk.value);
    }
    return buffer.length >= n;
  };
  const take = async (n: number) => {
    if (!(await need(n))) throw new Error("archive ended early");
    const out = buffer.slice(0, n);
    buffer = buffer.subarray(n);
    return out;
  };
  const drop = async (n: number) => {
    while (n > 0) {
      if (!(await need(Math.min(n, 64 * 1024)))) throw new Error("archive ended early");
      const k = Math.min(n, buffer.length);
      buffer = buffer.subarray(k);
      n -= k;
    }
  };
  let longName: string | null = null;
  try {
    while (await need(512)) {
      const header = await take(512);
      if (header.every((b) => b === 0)) break;
      const size = parseInt(text(header, 124, 12).trim() || "0", 8);
      const type = String.fromCharCode(header[156]!);
      const padded = Math.ceil(size / 512) * 512;
      const ustarPrefix = text(header, 345, 155);
      let path = longName ?? (ustarPrefix ? `${ustarPrefix}/${text(header, 0, 100)}` : text(header, 0, 100));
      longName = null;
      if (type === "x" || type === "L") {
        const data = new TextDecoder().decode((await take(padded)).subarray(0, size));
        if (type === "L") longName = data.replace(/\0+$/, "");
        else longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data)?.[1] ?? null;
        continue;
      }
      if (type !== "0" && type !== "\0") {
        await drop(padded);
        continue;
      }
      let used = false;
      path = path.replace(/^\.\//, "");
      yield {
        path,
        size,
        bytes: async () => {
          used = true;
          const data = await take(padded);
          return data.slice(0, size);
        },
        skip: async () => {
          used = true;
          await drop(padded);
        },
      };
      if (!used) await drop(padded);
    }
  } finally {
    reader.releaseLock();
  }
}

function text(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
