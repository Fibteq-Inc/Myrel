import type { Message, MemoryEntry, Project, ProjectFile, ServerEvent } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { indexListsNotes, knowledgeTools, type KnowledgeHost, renderKnowledge, withoutOwnHeading } from "../src/agents/knowledge";
import { agentProject, modelAgent, type Turn } from "./fake-agent";
import { type FakeRequest, resetFakeModel, setFakeModel } from "./fake-llm";

const BASE = "http://myrel.test";

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function setup() {
  const signUp = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email: `u${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "İsmail" }),
  });
  const token = signUp.headers.get("set-auth-token")!;
  // Its threads are worked by the fake model, as the person's CLI (see fake-agent.ts).
  const { project } = await agentProject(token, modelAgent);
  const base = `/api/projects/${project.id}`;
  return { token, project, base, agent: await getAgentByName(env.PROJECT_AGENT, project.id) };
}

async function until<T>(fn: () => T | Promise<T>, what: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 160; i++) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const call = (name: string, input: unknown) => ({ id: crypto.randomUUID(), name, input });
const isCoordinator = (r: FakeRequest) => r.system.includes("coordinator of a shared project chat");
const newMessageId = (prompt: string) => /\[(cmsg_[0-9A-Z]{26})\][^\n]*· NEW/.exec(prompt)?.[1];

afterEach(resetFakeModel);

describe("project knowledge API", () => {
  it("keeps instructions and memory, for members only", async () => {
    const { token, base } = await setup();
    const other = await setup();

    expect((await api(`${base}/instructions`)).status).toBe(401);
    expect((await api(`${base}/instructions`, { token: other.token })).status).toBe(404);

    let res = await api(`${base}/instructions`, { token, method: "PUT", body: JSON.stringify({ text: "Reply in Turkish." }) });
    expect(res.status).toBe(200);
    res = await api(`${base}/instructions`, { token });
    expect(((await res.json()) as { instructions: { text: string } }).instructions.text).toBe("Reply in Turkish.");

    res = await api(`${base}/memory/MEMORY`, {
      token,
      method: "PUT",
      body: JSON.stringify({ description: "Index", content: "- Owner writes Turkish." }),
    });
    expect(res.status).toBe(200);
    await api(`${base}/memory/deploy`, { token, method: "PUT", body: JSON.stringify({ description: "How deploys work", content: "Workers Builds" }) });
    expect((await api(`${base}/memory/-bad`, { token, method: "PUT", body: JSON.stringify({ description: "", content: "" }) })).status).toBe(400);

    res = await api(`${base}/memory`, { token });
    const { memory } = (await res.json()) as { memory: MemoryEntry[] };
    expect(memory.map((m) => m.name)).toEqual(["MEMORY", "deploy"]);
    expect(memory[0]).toMatchObject({ updatedByKind: "user", content: "- Owner writes Turkish." });

    expect((await api(`${base}/memory/deploy`, { token, method: "DELETE" })).status).toBe(200);
    expect((await api(`${base}/memory/deploy`, { token, method: "DELETE" })).status).toBe(404);
  });

  it("marks notes stale or checked and keeps the content before a change", async () => {
    const { token, base } = await setup();
    const put = (content: string) =>
      api(`${base}/memory/deploy`, { token, method: "PUT", body: JSON.stringify({ description: "How deploys work", content }) });
    const read = async () => ((await (await api(`${base}/memory`, { token })).json()) as { memory: MemoryEntry[] }).memory[0]!;

    await put("# deploy\n(How deploys work)\n\nWorkers Builds");
    let note = await read();
    // The heading memory_read adds anyway is not stored a second time.
    expect(note).toMatchObject({ content: "Workers Builds", status: "ok", previousContent: null });

    let res = await api(`${base}/memory/deploy/mark`, { token, method: "PUT", body: JSON.stringify({ status: "stale" }) });
    expect(res.status).toBe(400);
    res = await api(`${base}/memory/deploy/mark`, { token, method: "PUT", body: JSON.stringify({ status: "stale", reason: "Moved to GitHub Actions" }) });
    expect(res.status).toBe(200);
    note = await read();
    expect(note).toMatchObject({ status: "stale", staleReason: "Moved to GitHub Actions", content: "Workers Builds" });

    // A rewrite fixes the note: the mark goes, the old content stays one step back.
    await put("GitHub Actions");
    note = await read();
    expect(note).toMatchObject({ status: "ok", staleReason: null, content: "GitHub Actions", previousContent: "Workers Builds" });

    res = await api(`${base}/memory/deploy/mark`, { token, method: "PUT", body: JSON.stringify({ status: "ok" }) });
    expect(((await res.json()) as { memory: MemoryEntry }).memory.verifiedAt).toBeTruthy();
    expect((await api(`${base}/memory/nope/mark`, { token, method: "PUT", body: JSON.stringify({ status: "ok" }) })).status).toBe(404);
  });

  it("stores files in R2, lists, serves and deletes them", async () => {
    const { token, base } = await setup();
    let res = await api(`${base}/files/content?path=${encodeURIComponent("/notes/plan.md")}`, {
      token,
      method: "PUT",
      body: "# Plan\n",
      headers: { "content-type": "application/octet-stream" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { file: ProjectFile }).file).toMatchObject({
      path: "notes/plan.md",
      size: 7,
      contentType: "text/markdown; charset=utf-8",
    });
    expect((await api(`${base}/files/content?path=../x`, { token, method: "PUT", body: "x" })).status).toBe(400);

    res = await api(`${base}/files`, { token });
    expect(((await res.json()) as { files: ProjectFile[] }).files.map((f) => f.path)).toEqual(["notes/plan.md"]);

    res = await api(`${base}/files/content?path=notes/plan.md`, { token });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toBe("# Plan\n");

    expect((await api(`${base}/files/content?path=notes/plan.md`, { token, method: "DELETE" })).status).toBe(200);
    expect((await api(`${base}/files/content?path=notes/plan.md`, { token })).status).toBe(404);

    // Storing files waits for a verified address.
    const me = (await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } };
    await env.DB.prepare("UPDATE user SET email_verified = 0 WHERE id = ?").bind(me.user.id).run();
    expect((await api(`${base}/files/content?path=a.md`, { token, method: "PUT", body: "x" })).status).toBe(403);
    expect((await api(`${base}/uploads?name=a.md`, { token, method: "POST", body: "x" })).status).toBe(403);
  });
});

describe("agents and project knowledge", () => {
  it("shows attachments, instructions and memory to agents, and lets them write files and memory", async () => {
    const seen: FakeRequest[] = [];
    setFakeModel((req) => {
      seen.push(req);
      if (req.turns > 1) return { text: "", toolCalls: [] };
      if (isCoordinator(req)) {
        return {
          text: "",
          toolCalls: [
            call("start_thread", { message_id: newMessageId(req.prompt), title: "Summary", instructions: "Summarize the CSV.", project_ack: "On it." }),
          ],
        };
      }
      const upload = /📎 attached: (uploads\/\S+)/.exec(req.prompt)![1]!;
      return {
        text: "",
        toolCalls: [
          call("read_file", { path: upload }),
          call("write_file", { path: "/reports/summary.md", content: "Two rows." }),
          call("memory_write", { name: "MEMORY", description: "Index", content: "- Sales CSV summarized in reports/summary.md" }),
          call("reply", { text: "Wrote reports/summary.md." }),
        ],
      };
    });

    const { token, base, project, agent } = await setup();
    await api(`${base}/instructions`, { token, method: "PUT", body: JSON.stringify({ text: "Always answer in Turkish." }) });

    const res = await api(`${base}/uploads?name=${encodeURIComponent("sales data.csv")}`, {
      token,
      method: "POST",
      body: "a,b\n1,2\n",
      headers: { "content-type": "text/csv" },
    });
    expect(res.status).toBe(201);
    const { file } = (await res.json()) as { file: ProjectFile };
    expect(file.path).toMatch(/^uploads\/[0-9a-z]+-sales data\.csv$/);

    const ws = (await api(`${base}/ws?token=${encodeURIComponent(token)}`, { headers: { upgrade: "websocket" } })).webSocket!;
    const events: ServerEvent[] = [];
    ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string) as ServerEvent));
    ws.accept();

    // A path that is not a project file is refused.
    ws.send(JSON.stringify({ type: "message.send", body: "", attachments: ["uploads/nope.csv"] }));
    await until(() => events.find((e) => e.type === "error" && e.code === "no_file"), "no_file error");

    ws.send(JSON.stringify({ type: "message.send", body: "", attachments: [file.path] }));
    const thread = await until(async () => {
      const t = (await agent.listThreads())[0];
      return t?.status === "review_ready" ? t : null;
    }, "thread reply");

    const ctx = (await agent.getThreadContext(thread.id))!;
    expect(ctx.root.attachments).toEqual([{ path: file.path, name: file.path.split("/")[1], size: 8, contentType: "text/csv" }]);
    expect(ctx.messages.map((m: Message) => m.body)).toContain("Wrote reports/summary.md.");

    const threadReq = seen.find((r) => !isCoordinator(r))!;
    expect(threadReq.prompt).toContain("Always answer in Turkish.");
    expect(seen.find(isCoordinator)!.prompt).toContain("Always answer in Turkish.");

    expect(await agent.readFileText("reports/summary.md")).toEqual({ found: true, text: "Two rows.", size: 9 });
    expect((await agent.getMemory("MEMORY"))?.content).toContain("reports/summary.md");
    expect((await agent.getFile("reports/summary.md"))?.updatedByKind).toBe("agent");
    expect(events.some((e) => e.type === "knowledge.changed" && e.kind === "files")).toBe(true);
    expect(project.id).toBe(thread.projectId);
    ws.close();
  });
});

describe("binary files and harness agents", () => {
  it("hands the agent signed links to download and upload binary files", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
    const out: string[] = [];
    let upload = "";
    setFakeModel((req) => {
      if (req.turns > 1 || !isCoordinator(req)) return { text: "", toolCalls: [] };
      return {
        text: "",
        toolCalls: [call("start_thread", { message_id: newMessageId(req.prompt), title: "Image", instructions: "Look at it.", project_ack: "On it." })],
      };
    });

    const signUp = await api("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: `u${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "İsmail" }),
    });
    const token = signUp.headers.get("set-auth-token")!;
    const { project } = await agentProject(token, async (turn: Turn) => {
      const path = /📎 attached: (uploads\/\S+)/.exec(turn.prompt)![1]!;
      out.push((await turn.call("read_file", { path })).text);
      upload = (await turn.call("file_upload_url", { path: "reports/chart.png" })).text;
      await turn.call("reply", { text: "Done." });
    });
    const base = `/api/projects/${project.id}`;
    const agent = await getAgentByName(env.PROJECT_AGENT, project.id);

    // Whoever uploads names the file: a name meant to run in a shell stays a name.
    const res = await api(`${base}/uploads?name=${encodeURIComponent("$(id)`id`shot.png")}`, { token, method: "POST", body: png, headers: { "content-type": "image/png" } });
    const { file } = (await res.json()) as { file: ProjectFile };
    // Opening the project teaches it its public address, which the links point at.
    const ws = (await api(`${base}/ws?token=${encodeURIComponent(token)}`, { headers: { upgrade: "websocket" } })).webSocket!;
    ws.accept();
    ws.send(JSON.stringify({ type: "message.send", body: "Bak", attachments: [file.path] }));
    await until(() => upload, "the agent turn");

    // read_file on a binary file gives a curl command whose link serves the bytes.
    const get = /curl -fsSL -o '\.\/\$\(id\)`id`shot\.png' '(http[^']+)'/.exec(out[0]!)![1]!;
    const downloaded = await exports.default.fetch(new Request(get));
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(png);
    // The link is for that file and for reading only.
    const other = new URL(get);
    for (const [k, v] of other.searchParams) if (v === file.path) other.searchParams.set(k, "uploads/other.png");
    expect(other.href).not.toBe(get);
    expect((await exports.default.fetch(new Request(other))).status).toBe(403);
    expect((await exports.default.fetch(new Request(get, { method: "PUT", body: "x" }))).status).toBe(403);
    expect((await exports.default.fetch(new Request(get.replace(/sig=[^&]+/, "sig=AAAA")))).status).toBe(403);

    // file_upload_url gives a PUT link that stores the file as the agent's.
    const put = /--data-binary @LOCAL_FILE "(http[^"]+)"/.exec(upload)![1]!;
    const stored = await exports.default.fetch(new Request(put, { method: "PUT", body: png, headers: { "content-type": "image/png" } }));
    expect(stored.status).toBe(200);
    expect(await agent.getFile("reports/chart.png")).toMatchObject({ size: png.length, contentType: "image/png", updatedByKind: "agent" });
    ws.close();
  });
  it("attaches files the agent made to its reply, and refuses a path with no file", async () => {
    setFakeModel((req) => {
      if (req.turns > 1 || !isCoordinator(req)) return { text: "", toolCalls: [] };
      return {
        text: "",
        toolCalls: [call("start_thread", { message_id: newMessageId(req.prompt), title: "Rapor", instructions: "Make it.", project_ack: "On it." })],
      };
    });
    const signUp = await api("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: `u${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "İsmail" }),
    });
    const token = signUp.headers.get("set-auth-token")!;
    const results: { isError: boolean; text: string }[] = [];
    let done = false;
    const { project } = await agentProject(token, async (turn: Turn) => {
      expect(turn.prompt).toContain("file_upload_url");
      results.push(await turn.call("reply", { text: "Here.", files: ["reports/missing.xlsx"] }));
      await turn.call("write_file", { path: "reports/summary.csv", content: "a,b\n1,2\n" });
      results.push(await turn.call("reply", { text: "Tablo hazır.", files: ["reports/summary.csv"] }));
      done = true;
    });
    const base = `/api/projects/${project.id}`;
    const agent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const ws = (await api(`${base}/ws?token=${encodeURIComponent(token)}`, { headers: { upgrade: "websocket" } })).webSocket!;
    ws.accept();
    ws.send(JSON.stringify({ type: "message.send", body: "Rapor hazırla" }));
    await until(() => done, "the agent turn");

    expect(results[0]!.isError).toBe(true);
    expect(results[1]!.isError).toBe(false);
    const thread = (await agent.listThreads())[0]!;
    const messages = (await agent.getThreadContext(thread.id))!.messages;
    expect(messages.map((m: Message) => m.body)).not.toContain("Here.");
    expect(messages.find((m: Message) => m.body === "Tablo hazır.")?.attachments).toEqual([
      { path: "reports/summary.csv", name: "summary.csv", size: 8, contentType: "text/csv; charset=utf-8" },
    ]);
    ws.close();
  });
});

describe("memory upkeep in prompts and tools", () => {
  const entry = (over: Partial<MemoryEntry>): MemoryEntry => ({
    name: "deploy",
    description: "How deploys work",
    content: "Workers Builds",
    updatedAt: "2026-10-22T10:00:00.000Z",
    updatedByKind: "agent",
    updatedBy: "agent",
    status: "ok",
    staleReason: null,
    verifiedAt: null,
    previousContent: null,
    previousAt: null,
    ...over,
  });

  function fakeHost(notes: MemoryEntry[]) {
    const store = new Map(notes.map((n) => [n.name, n]));
    const host: KnowledgeHost = {
      memoryRead: (name) => store.get(name) ?? null,
      memoryWrite: (name, description, content) => store.set(name, entry({ name, description, content })),
      memoryMark: (name, input) => {
        const n = store.get(name);
        if (!n) return null;
        const next = input.status === "ok" ? { ...n, status: "ok" as const, verifiedAt: new Date().toISOString() } : { ...n, status: "stale" as const, staleReason: input.reason };
        store.set(name, next);
        return next;
      },
      memoryDelete: (name) => store.delete(name),
      memoryNames: () => [...store.keys()],
      listFiles: () => [],
      readText: async () => ({ found: false, text: null, size: 0 }),
      writeText: async () => {
        throw new Error("unused");
      },
    };
    const tools = knowledgeTools(host);
    const run = async (name: string, input: unknown) => (await tools.find((t) => t.name === name)!.run(input as never)) as string;
    return { store, run };
  }

  it("shows each note's date, who wrote it and a stale mark", () => {
    const text = renderKnowledge({
      instructions: "",
      memoryIndex: "Reply in Turkish.",
      memoryIndexAt: "2026-10-20T08:00:00.000Z",
      memory: [
        entry({ verifiedAt: "2026-10-23T09:00:00.000Z" }),
        entry({ name: "pricing", updatedByKind: "user", status: "stale", staleReason: "Prices changed in October" }),
      ],
      files: [],
      moreFiles: 0,
    });
    expect(text).toContain("MEMORY (index, shown in full; updated 2026-10-20)");
    expect(text).toContain("- deploy (2026-10-22, Myrel, checked 2026-10-23): How deploys work");
    expect(text).toContain("- pricing [MAY BE STALE: Prices changed in October] (2026-10-22, a member): How deploys work");
  });

  it("lets agents delete only notes marked stale, and warns when the index lists notes", async () => {
    const { store, run } = fakeHost([entry({}), entry({ name: "pricing" }), entry({ name: "release" })]);
    await expect(run("memory_delete", { name: "deploy" })).rejects.toThrow(/not marked stale/);
    await expect(run("memory_mark", { name: "deploy", status: "stale" })).rejects.toThrow(/why/);
    expect(await run("memory_mark", { name: "deploy", status: "stale", reason: "Moved" })).toContain("stale");
    expect(await run("memory_delete", { name: "deploy" })).toBe("Deleted deploy.");
    expect(store.has("deploy")).toBe(false);

    const read = await run("memory_read", { name: "pricing" });
    expect(read).toContain("Last written (2026-10-22, Myrel).");

    const listing = "- pricing: what we charge\n- release: how we ship\n- `deploy`: gone";
    // Two names are not a list worth warning about; three are.
    expect(await run("memory_write", { name: "MEMORY", description: "Index", content: listing })).toBe("Saved memory MEMORY.");
    expect(indexListsNotes(listing, ["pricing", "release"])).toBe(2);
    store.set("deploy", entry({}));
    expect(await run("memory_write", { name: "MEMORY", description: "Index", content: listing })).toContain("lists 3 other notes");
    expect(await run("memory_write", { name: "MEMORY", description: "Index", content: "Reply in Turkish." })).toBe("Saved memory MEMORY.");
  });

  it("drops only a heading that repeats the note's own name", () => {
    expect(withoutOwnHeading("deploy", "How", "# deploy\n(How)\n\nBody")).toBe("Body");
    expect(withoutOwnHeading("deploy", "How", "\n# deploy\n\nBody")).toBe("Body");
    expect(withoutOwnHeading("deploy", "How", "# Deploys\nBody")).toBe("# Deploys\nBody");
    expect(withoutOwnHeading("deploy", "How", "Body\n# deploy")).toBe("Body\n# deploy");
  });
});
