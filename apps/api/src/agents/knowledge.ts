import {
  type Attachment,
  type AuthorKind,
  type Instructions,
  MAX_FILE_SIZE,
  MEMORY_INDEX,
  type MarkMemoryInput,
  type MemoryEntry,
  MemoryName,
  type MemoryStatus,
  isValidFilePath,
  type KnowledgeKind,
  normalizeFilePath,
  type ProjectFile,
  UPLOADS_FOLDER,
} from "@myrel/protocol";
import { z } from "zod";
import { shellQuote } from "@myrel/runner-core";
import { type Tool, tool } from "../llm";

type Value = string | number | boolean | null;
type Sql = <T>(strings: TemplateStringsArray, ...values: Value[]) => T[];

type FileRow = {
  path: string;
  size: number;
  content_type: string;
  updated_at: string;
  updated_by_kind: AuthorKind;
  updated_by: string;
};

type MemoryRow = {
  name: string;
  description: string;
  content: string;
  updated_at: string;
  updated_by_kind: AuthorKind;
  updated_by: string;
  status: MemoryStatus;
  stale_reason: string | null;
  verified_at: string | null;
  previous_content: string | null;
  previous_at: string | null;
};

export type Author = { kind: AuthorKind; id: string };

/** What every agent sees about the project's knowledge at the start of a turn. */
export type KnowledgeSnapshot = {
  instructions: string;
  memoryIndex: string;
  /** When the index was last written, if it exists. */
  memoryIndexAt?: string | null;
  memory: MemoryLine[];
  files: { path: string; size: number }[];
  /** Files beyond the ones listed. */
  moreFiles: number;
};

/** What an agent sees about a note before reading it: enough to tell how old it is and whether it was doubted. */
export type MemoryLine = Pick<MemoryEntry, "name" | "description"> &
  Partial<Pick<MemoryEntry, "updatedAt" | "updatedByKind" | "status" | "staleReason" | "verifiedAt">>;

/** Files listed in an agent's prompt; the rest it finds with list_files. */
const PROMPT_FILE_LIMIT = 60;
/** A read_file call returns at most this much text. */
const READ_CHAR_LIMIT = 60_000;

/** The R2 key of a project file. Artifacts and other features use other prefixes. */
export function fileKey(projectId: string, path: string) {
  return `projects/${projectId}/files/${path}`;
}

/**
 * Project instructions, memory and the file index, kept in the ProjectAgent's
 * SQLite. File bytes live in R2 (FILES); this index is what lists and prompts read.
 */
export class KnowledgeStore {
  constructor(
    private readonly sql: Sql,
    private readonly bucket: R2Bucket | undefined,
    private readonly projectId: () => string,
    private readonly changed: (kind: KnowledgeKind) => void,
  ) {
    sql`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    sql`CREATE TABLE IF NOT EXISTS memory (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by_kind TEXT NOT NULL,
      updated_by TEXT NOT NULL
    )`;
    // Columns added after the table first shipped: whether a note was doubted or checked, and the
    // content before its last change (memory_write replaces a note whole).
    const columns = new Set(sql<{ name: string }>`PRAGMA table_info(memory)`.map((c) => c.name));
    if (!columns.has("status")) sql`ALTER TABLE memory ADD COLUMN status TEXT NOT NULL DEFAULT 'ok'`;
    if (!columns.has("stale_reason")) sql`ALTER TABLE memory ADD COLUMN stale_reason TEXT`;
    if (!columns.has("verified_at")) sql`ALTER TABLE memory ADD COLUMN verified_at TEXT`;
    if (!columns.has("previous_content")) sql`ALTER TABLE memory ADD COLUMN previous_content TEXT`;
    if (!columns.has("previous_at")) sql`ALTER TABLE memory ADD COLUMN previous_at TEXT`;
    sql`CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by_kind TEXT NOT NULL,
      updated_by TEXT NOT NULL
    )`;
  }

  // ---- Instructions ------------------------------------------------------

  getInstructions(): Instructions {
    const get = (key: string) => this.sql<{ value: string }>`SELECT value FROM settings WHERE key = ${key}`[0]?.value ?? null;
    return { text: get("instructions") ?? "", updatedAt: get("instructions_at"), updatedBy: get("instructions_by") };
  }

  setInstructions(text: string, by: Author): Instructions {
    const now = new Date().toISOString();
    for (const [key, value] of [
      ["instructions", text],
      ["instructions_at", now],
      ["instructions_by", by.id],
    ] as const) {
      this.sql`INSERT INTO settings (key, value) VALUES (${key}, ${value})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
    }
    this.changed("instructions");
    return this.getInstructions();
  }

  // ---- Memory ------------------------------------------------------------

  listMemory(): MemoryEntry[] {
    return this.sql<MemoryRow>`SELECT * FROM memory ORDER BY name = ${MEMORY_INDEX} DESC, name`.map(toMemory);
  }

  getMemory(name: string): MemoryEntry | null {
    const [row] = this.sql<MemoryRow>`SELECT * FROM memory WHERE name = ${name}`;
    return row ? toMemory(row) : null;
  }

  /** Writes a note whole. A rewrite counts as fixed: it clears a stale mark, and the old content is kept once. */
  putMemory(name: string, input: { description: string; content: string }, by: Author): MemoryEntry {
    const now = new Date().toISOString();
    const content = withoutOwnHeading(name, input.description, input.content);
    const before = this.getMemory(name);
    const changed = !!before && before.content !== content;
    const previousContent = changed ? before.content : (before?.previousContent ?? null);
    const previousAt = changed ? before.updatedAt : (before?.previousAt ?? null);
    this.sql`INSERT INTO memory (name, description, content, updated_at, updated_by_kind, updated_by, status, stale_reason,
        verified_at, previous_content, previous_at)
      VALUES (${name}, ${input.description}, ${content}, ${now}, ${by.kind}, ${by.id}, ${"ok"}, ${null},
        ${before?.verifiedAt ?? null}, ${previousContent}, ${previousAt})
      ON CONFLICT(name) DO UPDATE SET description = excluded.description, content = excluded.content,
        updated_at = excluded.updated_at, updated_by_kind = excluded.updated_by_kind, updated_by = excluded.updated_by,
        status = excluded.status, stale_reason = excluded.stale_reason,
        previous_content = excluded.previous_content, previous_at = excluded.previous_at`;
    this.changed("memory");
    return this.getMemory(name)!;
  }

  /** Records that a note was checked and still holds, or that it may no longer be true. Content stays as it is. */
  markMemory(name: string, input: MarkMemoryInput): MemoryEntry | null {
    if (!this.getMemory(name)) return null;
    if (input.status === "ok") {
      this.sql`UPDATE memory SET status = 'ok', stale_reason = NULL, verified_at = ${new Date().toISOString()} WHERE name = ${name}`;
    } else {
      this.sql`UPDATE memory SET status = 'stale', stale_reason = ${input.reason} WHERE name = ${name}`;
    }
    this.changed("memory");
    return this.getMemory(name);
  }

  deleteMemory(name: string): boolean {
    const existed = !!this.getMemory(name);
    this.sql`DELETE FROM memory WHERE name = ${name}`;
    if (existed) this.changed("memory");
    return existed;
  }

  // ---- Files -------------------------------------------------------------

  listFiles(prefix = ""): ProjectFile[] {
    const rows = this.sql<FileRow>`SELECT * FROM files ORDER BY path`;
    return rows.filter((r) => r.path.startsWith(prefix)).map(toFile);
  }

  getFile(path: string): ProjectFile | null {
    const [row] = this.sql<FileRow>`SELECT * FROM files WHERE path = ${path}`;
    return row ? toFile(row) : null;
  }

  /** Records a file whose bytes are already in R2 (uploads go straight from the API Worker to R2). */
  recordFile(file: { path: string; size: number; contentType: string }, by: Author): ProjectFile {
    const now = new Date().toISOString();
    this.sql`INSERT INTO files (path, size, content_type, updated_at, updated_by_kind, updated_by)
      VALUES (${file.path}, ${file.size}, ${file.contentType}, ${now}, ${by.kind}, ${by.id})
      ON CONFLICT(path) DO UPDATE SET size = excluded.size, content_type = excluded.content_type,
        updated_at = excluded.updated_at, updated_by_kind = excluded.updated_by_kind, updated_by = excluded.updated_by`;
    this.changed("files");
    return this.getFile(file.path)!;
  }

  /** Bytes the project's files take, leaving out `except` (a file about to be replaced). */
  filesBytes(except?: string): number {
    return this.sql<{ n: number | null }>`SELECT SUM(size) AS n FROM files WHERE path != ${except ?? ""}`[0]?.n ?? 0;
  }

  forgetFile(path: string): boolean {
    const existed = !!this.getFile(path);
    this.sql`DELETE FROM files WHERE path = ${path}`;
    if (existed) this.changed("files");
    return existed;
  }

  async writeText(path: string, content: string, by: Author): Promise<ProjectFile> {
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > MAX_FILE_SIZE) throw new Error("File is too large.");
    const contentType = contentTypeFor(path);
    await this.requireBucket().put(fileKey(this.projectId(), path), bytes, { httpMetadata: { contentType } });
    return this.recordFile({ path, size: bytes.byteLength, contentType }, by);
  }

  /** Text of a file, or null when it is binary. */
  async readText(path: string): Promise<string | null> {
    const object = await this.requireBucket().get(fileKey(this.projectId(), path));
    if (!object) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      return text.includes("\u0000") ? null : text;
    } catch {
      return null;
    }
  }

  /** Message attachments: each path must be a file in the project. */
  attachmentsFor(paths: string[]): Attachment[] {
    return paths.map((path) => {
      const file = this.getFile(path);
      if (!file) throw new Error(`No file at ${path}`);
      return { path, name: path.split("/").at(-1)!, size: file.size, contentType: file.contentType };
    });
  }

  snapshot(): KnowledgeSnapshot {
    const memory = this.listMemory();
    const files = this.listFiles();
    const index = memory.find((m) => m.name === MEMORY_INDEX);
    return {
      instructions: this.getInstructions().text,
      memoryIndex: index?.content ?? "",
      memoryIndexAt: index?.updatedAt ?? null,
      memory: memory
        .filter((m) => m.name !== MEMORY_INDEX)
        .map(({ name, description, updatedAt, updatedByKind, status, staleReason, verifiedAt }) => ({
          name,
          description,
          updatedAt,
          updatedByKind,
          status,
          staleReason,
          verifiedAt,
        })),
      files: files.slice(0, PROMPT_FILE_LIMIT).map(({ path, size }) => ({ path, size })),
      moreFiles: Math.max(0, files.length - PROMPT_FILE_LIMIT),
    };
  }

  private requireBucket(): R2Bucket {
    if (!this.bucket) throw new Error("Project files are not set up on this server (no FILES R2 binding).");
    return this.bucket;
  }
}

/** A fresh path in the uploads folder for a file named `name`. */
export function uploadPath(name: string): string {
  const clean =
    name
      .normalize("NFC")
      .replace(/[\u0000-\u001f\u007f/\\]/g, "")
      .trim()
      .slice(-120) || "file";
  // Time first so uploads sort by when they arrived; the random part keeps same-name uploads apart.
  const stamp = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
  return `${UPLOADS_FOLDER}/${stamp}-${clean}`;
}

const TYPES: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  py: "text/x-python",
  yaml: "text/yaml",
  yml: "text/yaml",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

/** Content type from a file's extension; text written by agents is UTF-8. */
export function contentTypeFor(path: string, fallback = "text/plain"): string {
  const ext = path.split("/").at(-1)!.split(".").at(-1)!.toLowerCase();
  const type = TYPES[ext] ?? fallback;
  return type.startsWith("text/") && !type.includes("charset") ? `${type}; charset=utf-8` : type;
}

export function renderKnowledge(k: KnowledgeSnapshot): string {
  const parts: string[] = [];
  if (k.instructions.trim()) {
    parts.push(`## Project instructions (set by members; follow them)\n${k.instructions.trim()}`);
  }
  const indexAt = k.memoryIndexAt ? `; updated ${day(k.memoryIndexAt)}` : "";
  const memory = [
    k.memoryIndex.trim() ? `${MEMORY_INDEX} (index, shown in full${indexAt}):\n${k.memoryIndex.trim()}` : "(MEMORY is empty)",
    ...(k.memory.length ? ["", "Notes (when each was last written or checked):"] : []),
    ...k.memory.map(memoryLine),
  ];
  parts.push(`## Project memory (notes kept across threads; read a file with memory_read)\n${memory.join("\n")}`);
  const files = k.files.map((f) => `- ${f.path} (${formatSize(f.size)})`);
  if (k.moreFiles) files.push(`- …and ${k.moreFiles} more (use list_files)`);
  parts.push(`## Project files (shared folder; read_file / write_file)\n${files.join("\n") || "(no files yet)"}`);
  return parts.join("\n\n");
}

/** One note in the prompt: name, age, a stale mark if someone doubted it, and when to read it. */
export function memoryLine(m: MemoryLine): string {
  const stale = m.status === "stale" ? ` [MAY BE STALE: ${m.staleReason || "no reason given"}]` : "";
  return `- ${m.name}${stale}${noteAge(m)}: ${m.description || "(no description)"}`;
}

function noteAge(m: Pick<MemoryLine, "updatedAt" | "updatedByKind" | "verifiedAt">): string {
  if (!m.updatedAt) return "";
  const by = m.updatedByKind === "user" ? "a member" : "Myrel";
  const checked = m.verifiedAt && m.verifiedAt > m.updatedAt ? `, checked ${day(m.verifiedAt)}` : "";
  return ` (${day(m.updatedAt)}, ${by}${checked})`;
}

const day = (iso: string) => iso.slice(0, 10);

/**
 * Agents often start a note with its own name and description, which memory_read already shows
 * above it, so the note read back showed them twice. Drops that heading (and the description line
 * under it) before the note is stored.
 */
export function withoutOwnHeading(name: string, description: string, content: string): string {
  const lines = content.split("\n");
  let i = 0;
  const skipBlank = () => {
    while (i < lines.length && !lines[i]!.trim()) i++;
  };
  skipBlank();
  if (lines[i]?.trim() !== `# ${name}`) return content;
  i++;
  skipBlank();
  if (description.trim() && lines[i]?.trim() === `(${description.trim()})`) {
    i++;
    skipBlank();
  }
  return lines.slice(i).join("\n");
}

/**
 * Index lines like "- deploy: ..." that name other notes. Every note is listed under the index with
 * its description already, so an index that lists them goes stale the moment a note changes.
 */
export function indexListsNotes(content: string, names: string[]): number {
  const known = new Set(names.filter((n) => n !== MEMORY_INDEX));
  let n = 0;
  for (const line of content.split("\n")) {
    const m = /^\s*[-*]\s+\**`?([^\s:`*]+)`?\**\s*:/.exec(line);
    if (m && known.has(m[1]!)) n++;
  }
  return n;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** How the knowledge tools reach the store: directly in the ProjectAgent, over RPC from a ThreadAgent. */
export type KnowledgeHost = {
  memoryRead(name: string): Promise<MemoryEntry | null> | MemoryEntry | null;
  memoryWrite(name: string, description: string, content: string): Promise<unknown> | unknown;
  memoryMark(name: string, input: MarkMemoryInput): Promise<MemoryEntry | null> | MemoryEntry | null;
  memoryDelete(name: string): Promise<boolean> | boolean;
  memoryNames(): Promise<string[]> | string[];
  listFiles(prefix: string): Promise<ProjectFile[]> | ProjectFile[];
  readText(path: string): Promise<{ found: boolean; text: string | null; size: number }>;
  writeText(path: string, content: string): Promise<ProjectFile>;
  /**
   * A short-lived link to download (get) or upload (put) one file with curl. Only harness agents,
   * which have a shell, get it; without it binary files stay out of reach.
   */
  fileLink?(path: string, mode: "get" | "put"): Promise<string | null>;
};

export const KNOWLEDGE_GUIDE = `Project knowledge:
- Project instructions are set by members. Follow them in everything you do.
- Project memory is shared by every agent in this project and outlives this conversation. Save what a later agent would otherwise have to ask again or rediscover: how people want you to work, decisions they made, facts about the project. Keep one memory file per subject (memory_write replaces the whole file, so read it first and keep what is still true). Every note is listed for every agent with its description and date, so make the description say when to read it and its key fact; keep MEMORY short and for project-wide rules, not a list of the other notes. Write time-bound facts with their date ("merged 2026-10-22", "still open on 2026-10-22"), never just "now" or "pending". Do not save what only matters to this conversation, and never save secrets.
- Memory goes stale. When a note disagrees with what you see (the code, a file, a pull request, a newer decision), fix it in the same turn. When you cannot tell whether it still holds, or it no longer applies, mark it with memory_mark as stale with the reason instead of deleting it; a person deletes it, or you do once they agreed. When you checked a note and it still holds, memory_mark it ok.
- Project files are the project's shared folder. Files people attach to messages land in uploads/. Read a file before relying on it (read_file hands you a download command for images, PDFs and other binary files); put results others will need in a file under a folder named for the work (write_file for text, file_upload_url for anything else), and mention it in your reply as a link with its path, such as [rapor.md](notes/rapor.md), which opens it for people.`;

export function knowledgeTools(host: KnowledgeHost): Tool[] {
  return [
    tool({
      name: "memory_read",
      description: "Read a project memory file in full.",
      input: z.object({ name: z.string() }),
      run: async ({ name }) => {
        const entry = await host.memoryRead(name.trim());
        if (!entry) throw new Error(`No memory file named ${name}.`);
        const stale = entry.status === "stale" ? `\nMAY BE STALE: ${entry.staleReason || "no reason given"}` : "";
        return `# ${entry.name}\n${entry.description ? `(${entry.description})\n` : ""}Last written${noteAge(entry)}.${stale}\n\n${entry.content}`;
      },
    }),
    tool({
      name: "memory_write",
      description: `Create or replace a project memory file. Use name "${MEMORY_INDEX}" for the short index everyone reads.`,
      input: z.object({
        name: MemoryName,
        description: z.string().max(300).describe("One line saying when to read this file and its key fact; every agent sees it."),
        content: z.string().max(16_000),
      }),
      run: async ({ name, description, content }) => {
        await host.memoryWrite(name, description, content);
        if (name === MEMORY_INDEX) {
          const listed = indexListsNotes(content, await host.memoryNames());
          if (listed >= 3) {
            return `Saved memory ${name}. It lists ${listed} other notes by name, but every note is already shown under the index with its description and date, so these lines only drift out of step. Keep MEMORY for project-wide rules and put each note's key fact in its description.`;
          }
        }
        return `Saved memory ${name}.`;
      },
    }),
    tool({
      name: "memory_mark",
      description:
        "Mark a project memory file as checked (status ok: you verified it still holds) or stale (it may no longer be true; give the reason). The content stays; people see the mark.",
      input: z.object({
        name: z.string(),
        status: z.enum(["ok", "stale"]),
        reason: z.string().max(300).optional().describe("Why it may be stale, e.g. \"PR #12 was merged since\". Required for stale."),
      }),
      run: async ({ name, status, reason }) => {
        if (status === "stale" && !reason?.trim()) throw new Error("Say why the note may be stale.");
        const entry = await host.memoryMark(name.trim(), status === "ok" ? { status } : { status, reason: reason!.trim() });
        if (!entry) throw new Error(`No memory file named ${name}.`);
        return status === "ok" ? `Marked ${name} as checked.` : `Marked ${name} as stale.`;
      },
    }),
    tool({
      name: "memory_delete",
      description:
        "Delete a project memory file. Only notes marked stale with memory_mark can be deleted, and only once a person agreed or the note is plainly wrong.",
      input: z.object({ name: z.string() }),
      run: async ({ name }) => {
        const entry = await host.memoryRead(name.trim());
        if (!entry) return `No memory file named ${name}.`;
        if (entry.status !== "stale") {
          throw new Error(`${name} is not marked stale. Fix it with memory_write, or mark it stale with memory_mark and the reason; it is deleted once a person agrees.`);
        }
        return (await host.memoryDelete(name.trim())) ? `Deleted ${name}.` : `No memory file named ${name}.`;
      },
    }),
    tool({
      name: "list_files",
      description: "List project files, optionally under a folder.",
      input: z.object({ folder: z.string().optional() }),
      run: async ({ folder }) => {
        const prefix = folder ? `${normalizeFilePath(folder)}/` : "";
        const files = await host.listFiles(prefix === "/" ? "" : prefix);
        if (files.length === 0) return "No files.";
        return files.map((f) => `${f.path} · ${formatSize(f.size)} · ${f.contentType} · ${f.updatedAt}`).join("\n");
      },
    }),
    tool({
      name: "read_file",
      description: "Read a text file from the project files. Long files come back in pages of lines.",
      input: z.object({
        path: z.string(),
        offset: z.number().int().min(0).optional().describe("First line to return, 0-based."),
        limit: z.number().int().min(1).max(5000).optional().describe("Lines to return (default 1000)."),
      }),
      run: async ({ path, offset = 0, limit = 1000 }) => {
        const clean = checkedPath(path);
        const { found, text, size } = await host.readText(clean);
        if (!found) throw new Error(`No file at ${clean}.`);
        if (text === null) {
          const link = await host.fileLink?.(clean, "get");
          // Uploads carry a time stamp prefix; the original name is the useful one locally.
          const base = clean.split("/").at(-1)!;
          // The name is whoever uploaded the file's: quoted for the shell, never run as part of the command.
          const name = (clean.startsWith(`${UPLOADS_FOLDER}/`) ? base.replace(/^[0-9a-z]+-/, "") : base).replace(/[\u0000-\u001f\u007f]/g, "");
          return link
            ? `${clean} is a binary file (${formatSize(size)}). Download it into your working folder to use it (the link works for ${FILE_LINK_MINUTES} minutes):\ncurl -fsSL -o ${shellQuote(`./${name}`)} ${shellQuote(link)}`
            : `${clean} is a binary file (${formatSize(size)}); it cannot be read as text.`;
        }
        const lines = text.split("\n");
        let page = lines.slice(offset, offset + limit).join("\n");
        if (page.length > READ_CHAR_LIMIT) page = `${page.slice(0, READ_CHAR_LIMIT)}\n[…cut at ${READ_CHAR_LIMIT} characters]`;
        const end = Math.min(lines.length, offset + limit);
        const more = end < lines.length ? `\n[lines ${offset + 1}-${end} of ${lines.length}; pass offset ${end} for more]` : "";
        return page + more;
      },
    }),
    tool({
      name: "write_file",
      description: "Create or replace a text file in the project files.",
      input: z.object({ path: z.string().describe("Path inside the project files, e.g. notes/plan.md"), content: z.string() }),
      run: async ({ path, content }) => {
        const file = await host.writeText(checkedPath(path), content);
        return `Wrote ${file.path} (${formatSize(file.size)}).`;
      },
    }),
    ...(host.fileLink
      ? [
          tool({
            name: "file_upload_url",
            description:
              "Get a command that uploads a file from your working folder (an image, a PDF, a build) into the project files. Use write_file for text.",
            input: z.object({ path: z.string().describe("Where it goes in the project files, e.g. reports/chart.png") }),
            run: async ({ path }) => {
              const clean = checkedPath(path);
              const link = await host.fileLink!(clean, "put");
              if (!link) throw new Error("This server cannot hand out file links (it does not know its own address).");
              return `Run this within ${FILE_LINK_MINUTES} minutes, with your file in place of LOCAL_FILE:\ncurl -fsS -X PUT --data-binary @LOCAL_FILE "${link}"`;
            },
          }),
        ]
      : []),
  ];
}

// ---- Signed file links ----------------------------------------------------

export const FILE_LINK_MINUTES = 60;

type LinkClaims = { projectId: string; path: string; mode: "get" | "put"; by: string; exp: number };

async function linkKey(env: { BETTER_AUTH_SECRET: string }): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`myrel-file-links:${env.BETTER_AUTH_SECRET}`);
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const claimsText = (c: LinkClaims) => [c.projectId, c.path, c.mode, c.by, String(c.exp)].join("\n");

/** A link that lets whoever holds it get or put one project file until it expires. */
export async function signFileLink(
  env: { BETTER_AUTH_SECRET: string },
  origin: string,
  claims: Omit<LinkClaims, "exp">,
  now = Date.now(),
): Promise<string> {
  const full = { ...claims, exp: Math.floor(now / 1000) + FILE_LINK_MINUTES * 60 };
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await linkKey(env), new TextEncoder().encode(claimsText(full))));
  const query = new URLSearchParams({ path: full.path, by: full.by, exp: String(full.exp), sig: base64url(sig) });
  return `${origin}/api/file-links/${encodeURIComponent(full.projectId)}?${query}`;
}

export async function verifyFileLink(env: { BETTER_AUTH_SECRET: string }, c: LinkClaims & { sig: string }): Promise<boolean> {
  if (!Number.isFinite(c.exp) || c.exp * 1000 < Date.now() || !c.by) return false;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = Uint8Array.from(atob(c.sig.replaceAll("-", "+").replaceAll("_", "/")), (ch) => ch.charCodeAt(0));
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", await linkKey(env), sig, new TextEncoder().encode(claimsText(c)));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function checkedPath(input: string): string {
  const path = normalizeFilePath(input);
  if (!isValidFilePath(path)) throw new Error(`Invalid path "${input}". Use a path like notes/plan.md.`);
  return path;
}

function toMemory(r: MemoryRow): MemoryEntry {
  return {
    name: r.name,
    description: r.description,
    content: r.content,
    updatedAt: r.updated_at,
    updatedByKind: r.updated_by_kind,
    updatedBy: r.updated_by,
    status: r.status === "stale" ? "stale" : "ok",
    staleReason: r.stale_reason,
    verifiedAt: r.verified_at,
    previousContent: r.previous_content,
    previousAt: r.previous_at,
  };
}

function toFile(r: FileRow): ProjectFile {
  return {
    path: r.path,
    size: r.size,
    contentType: r.content_type,
    updatedAt: r.updated_at,
    updatedByKind: r.updated_by_kind,
    updatedBy: r.updated_by,
  };
}
