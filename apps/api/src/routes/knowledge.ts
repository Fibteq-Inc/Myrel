import {
  isValidFilePath,
  MAX_FILE_SIZE,
  MemoryName,
  normalizeFilePath,
  PutInstructionsInput,
  PutMemoryInput,
} from "@altair/protocol";
import { getAgentByName } from "agents";
import type { Context } from "hono";
import { Hono } from "hono";
import { type Author, contentTypeFor, fileKey, uploadPath, verifyFileLink } from "../agents/knowledge";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../middleware";
import { findMembership } from "./projects";

type Ctx = Context<AppEnv>;

/** Only members of the project get past this. */
const member = createMiddleware<AppEnv>(async (c, next) => {
  if (!(await findMembership(c.env, c.req.param("id")!, c.get("user").id))) return c.json({ error: "not_found" }, 404);
  await next();
});

/**
 * Project instructions, memory and files. Mounted at /projects next to projectRoutes,
 * whose requireUser middleware runs first; every route here also requires membership.
 */
export const knowledgeRoutes = new Hono<AppEnv>()

  // ---- Instructions ----
  .get("/:id/instructions", member, async (c) => c.json({ instructions: await (await agent(c)).getInstructions() }))
  .put("/:id/instructions", member, async (c) => {
    const input = PutInstructionsInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    return c.json({ instructions: await (await agent(c)).setInstructions(input.data.text, by(c)) });
  })

  // ---- Memory ----
  .get("/:id/memory", member, async (c) => c.json({ memory: await (await agent(c)).listMemory() }))
  .put("/:id/memory/:name", member, async (c) => {
    const name = MemoryName.safeParse(c.req.param("name"));
    const input = PutMemoryInput.safeParse(await c.req.json().catch(() => null));
    if (!name.success) return c.json({ error: "invalid_name", issues: name.error.issues }, 400);
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    return c.json({ memory: await (await agent(c)).putMemory(name.data, input.data, by(c)) });
  })
  .delete("/:id/memory/:name", member, async (c) => {
    const deleted = await (await agent(c)).deleteMemory(c.req.param("name"));
    return deleted ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  })

  // ---- Files ----
  .get("/:id/files", member, async (c) => {
    const prefix = c.req.query("prefix") ?? "";
    return c.json({ files: await (await agent(c)).listFiles(prefix) });
  })
  .get("/:id/files/content", member, async (c) => {
    const path = queryPath(c);
    if (!path) return c.json({ error: "invalid_path" }, 400);
    return serve(c, c.req.param("id")!, path);
  })
  .put("/:id/files/content", member, async (c) => {
    const path = queryPath(c);
    if (!path) return c.json({ error: "invalid_path" }, 400);
    return store(c, c.req.param("id")!, path, by(c));
  })
  .delete("/:id/files/content", member, async (c) => {
    const path = queryPath(c);
    if (!path) return c.json({ error: "invalid_path" }, 400);
    const project = await agent(c);
    if (!(await project.getFile(path))) return c.json({ error: "not_found" }, 404);
    await c.env.FILES?.delete(fileKey(c.req.param("id")!, path));
    await project.forgetFile(path);
    return c.json({ ok: true });
  })
  // A file to attach to a message: stored under uploads/ with a fresh name, then sent by path.
  .post("/:id/uploads", member, async (c) => {
    const name = c.req.query("name");
    if (!name) return c.json({ error: "missing_name" }, 400);
    const path = uploadPath(name);
    if (!isValidFilePath(path)) return c.json({ error: "invalid_name" }, 400);
    return store(c, c.req.param("id")!, path, by(c), 201);
  });

/**
 * Signed links a thread's agent gets from read_file / file_upload_url, so a harness can move binary
 * files between its working folder and the project files with curl. No session: the signature is
 * the permission, for one path, one direction and a short time. Mounted at /api/file-links.
 */
export const fileLinkRoutes = new Hono<AppEnv>()
  .get("/:projectId", async (c) => {
    const link = await checkLink(c, "get");
    return link ? serve(c, link.projectId, link.path) : c.json({ error: "invalid_link" }, 403);
  })
  .put("/:projectId", async (c) => {
    const link = await checkLink(c, "put");
    return link ? store(c, link.projectId, link.path, { kind: "agent", id: link.by }) : c.json({ error: "invalid_link" }, 403);
  });

async function checkLink(c: Ctx, mode: "get" | "put") {
  const projectId = c.req.param("projectId")!;
  const path = queryPath(c);
  const ok =
    path &&
    (await verifyFileLink(c.env, {
      projectId,
      path,
      mode,
      by: c.req.query("by") ?? "",
      exp: Number(c.req.query("exp")),
      sig: c.req.query("sig") ?? "",
    }));
  return ok ? { projectId, path, by: c.req.query("by")! } : null;
}

async function serve(c: Ctx, projectId: string, path: string) {
  const bucket = c.env.FILES;
  const project = await getAgentByName(c.env.PROJECT_AGENT, projectId);
  const file = await project.getFile(path);
  const object = file && bucket ? await bucket.get(fileKey(projectId, path)) : null;
  if (!file || !object) return c.json({ error: "not_found" }, 404);
  const name = path.split("/").at(-1)!;
  const disposition = c.req.query("download") ? "attachment" : "inline";
  return new Response(object.body, {
    headers: {
      "content-type": file.contentType,
      "content-length": String(object.size),
      "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
      // Files are user content served from the app's origin: never let them run scripts or be sniffed.
      "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-cache",
    },
  });
}

async function store(c: Ctx, projectId: string, path: string, author: Author, status: 200 | 201 = 200) {
  if (!c.env.FILES) return c.json({ error: "files_not_configured" }, 501);
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_FILE_SIZE) return c.json({ error: "too_large", maxBytes: MAX_FILE_SIZE }, 413);
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > MAX_FILE_SIZE) return c.json({ error: "too_large", maxBytes: MAX_FILE_SIZE }, 413);

  const sent = c.req.header("content-type")?.split(";")[0]?.trim();
  // Browsers send octet-stream for unknown types; the extension usually knows better.
  const contentType =
    sent && sent !== "application/octet-stream" ? (c.req.header("content-type") as string) : contentTypeFor(path, "application/octet-stream");
  await c.env.FILES.put(fileKey(projectId, path), bytes, { httpMetadata: { contentType } });
  const project = await getAgentByName(c.env.PROJECT_AGENT, projectId);
  const file = await project.recordFile({ path, size: bytes.byteLength, contentType }, author);
  return c.json({ file }, status);
}

function queryPath(c: Ctx): string | null {
  const path = normalizeFilePath(c.req.query("path") ?? "");
  return isValidFilePath(path) ? path : null;
}

function by(c: Ctx): Author {
  return { kind: "user", id: c.get("user").id };
}

function agent(c: Ctx) {
  return getAgentByName(c.env.PROJECT_AGENT, c.req.param("id")!);
}
