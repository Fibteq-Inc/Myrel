import {
  type Attachment,
  type AuthorKind,
  type Instructions,
  MAX_FILE_SIZE,
  MEMORY_INDEX,
  type MemoryEntry,
  MemoryName,
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
};

export type Author = { kind: AuthorKind; id: string };

/** What every agent sees about the project's knowledge at the start of a turn. */
export type KnowledgeSnapshot = {
  instructions: string;
  memoryIndex: string;
  memory: { name: string; description: string }[];
  files: { path: string; size: number }[];
  /** Files beyond the ones listed. */
  moreFiles: number;
};

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

  putMemory(name: string, input: { description: string; content: string }, by: Author): MemoryEntry {
    const now = new Date().toISOString();
    this.sql`INSERT INTO memory (name, description, content, updated_at, updated_by_kind, updated_by)
      VALUES (${name}, ${input.description}, ${input.content}, ${now}, ${by.kind}, ${by.id})
      ON CONFLICT(name) DO UPDATE SET description = excluded.description, content = excluded.content,
        updated_at = excluded.updated_at, updated_by_kind = excluded.updated_by_kind, updated_by = excluded.updated_by`;
    this.changed("memory");
    return this.getMemory(name)!;
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
    return {
      instructions: this.getInstructions().text,
      memoryIndex: memory.find((m) => m.name === MEMORY_INDEX)?.content ?? "",
      memory: memory.filter((m) => m.name !== MEMORY_INDEX).map(({ name, description }) => ({ name, description })),
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
  const memory = [
    k.memoryIndex.trim() ? `${MEMORY_INDEX} (index, shown in full):\n${k.memoryIndex.trim()}` : "(MEMORY is empty)",
    ...k.memory.map((m) => `- ${m.name}: ${m.description || "(no description)"}`),
  ];
  parts.push(`## Project memory (notes kept across threads; read a file with memory_read)\n${memory.join("\n")}`);
  const files = k.files.map((f) => `- ${f.path} (${formatSize(f.size)})`);
  if (k.moreFiles) files.push(`- …and ${k.moreFiles} more (use list_files)`);
  parts.push(`## Project files (shared folder; read_file / write_file)\n${files.join("\n") || "(no files yet)"}`);
  return parts.join("\n\n");
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
  memoryDelete(name: string): Promise<boolean> | boolean;
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
- Project memory is shared by every agent in this project and outlives this conversation. Save what a later agent would otherwise have to ask again or rediscover: how people want you to work, decisions they made, facts about the project. Keep one memory file per subject (memory_write replaces the whole file, so read it first and keep what is still true), and keep MEMORY short: it is the index everyone reads in full. Do not save what only matters to this conversation, and never save secrets.
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
        return `# ${entry.name}\n${entry.description ? `(${entry.description})\n` : ""}\n${entry.content}`;
      },
    }),
    tool({
      name: "memory_write",
      description: `Create or replace a project memory file. Use name "${MEMORY_INDEX}" for the short index everyone reads.`,
      input: z.object({
        name: MemoryName,
        description: z.string().max(300).describe("One line saying when to read this file."),
        content: z.string().max(16_000),
      }),
      run: async ({ name, description, content }) => {
        await host.memoryWrite(name, description, content);
        return `Saved memory ${name}.`;
      },
    }),
    tool({
      name: "memory_delete",
      description: "Delete a project memory file that turned out wrong or obsolete.",
      input: z.object({ name: z.string() }),
      run: async ({ name }) => ((await host.memoryDelete(name.trim())) ? `Deleted ${name}.` : `No memory file named ${name}.`),
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
