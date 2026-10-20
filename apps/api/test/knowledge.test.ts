import type { Message, MemoryEntry, Project, ProjectFile, ServerEvent } from "@altair/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeRequest, resetFakeModel, setFakeModel } from "./fake-llm";

const BASE = "http://altair.test";

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
  const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Altair" }) });
  const { project } = (await res.json()) as { project: Project };
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
