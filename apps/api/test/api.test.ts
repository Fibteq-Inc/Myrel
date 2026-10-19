import { type Message, type Project, ServerEvent } from "@altair/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "http://altair.test";

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function signUp(email = `u${crypto.randomUUID()}@example.com`) {
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "Test" }),
  });
  expect(res.status).toBe(200);
  const token = res.headers.get("set-auth-token");
  expect(token).toBeTruthy();
  return token!;
}

async function createProject(token: string, name = "Demo"): Promise<Project> {
  const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { project: Project }).project;
}

describe("GET /api/health", () => {
  it("returns ok", async () => {
    const res = await api("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("projects", () => {
  it("requires auth", async () => {
    expect((await api("/api/projects")).status).toBe(401);
  });

  it("creates and lists projects scoped to the user", async () => {
    const alice = await signUp();
    const bob = await signUp();
    const project = await createProject(alice, "Alice's project");
    expect(project).toMatchObject({ name: "Alice's project", role: "owner" });

    const list = async (token: string) =>
      ((await (await api("/api/projects", { token })).json()) as { projects: Project[] }).projects;
    expect((await list(alice)).map((p) => p.id)).toEqual([project.id]);
    expect(await list(bob)).toEqual([]);
    expect((await api(`/api/projects/${project.id}`, { token: bob })).status).toBe(404);
  });

  it("rejects invalid input", async () => {
    const token = await signUp();
    const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: " " }) });
    expect(res.status).toBe(400);
  });
});

describe("ProjectAgent", () => {
  it("assigns monotonically increasing seq and syncs after a cursor", async () => {
    const agent = await getAgentByName(env.PROJECT_AGENT, "proj_01JTESTSEQ0000000000000000");
    const sent: Message[] = [];
    for (const body of ["one", "two", "three"]) {
      sent.push(await agent.sendMessage({ threadId: null, authorKind: "user", authorId: "u1", body }));
    }
    expect(sent.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(sent[0]!.id).toMatch(/^cmsg_/);

    const after1 = await agent.getMessagesAfter(1);
    expect(after1.messages.map((m) => m.body)).toEqual(["two", "three"]);
    expect(after1.hasMore).toBe(false);

    const page = await agent.getMessagesAfter(0, 2);
    expect(page.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(page.hasMore).toBe(true);
  });

  it("accepts authenticated WebSocket clients, broadcasts and syncs", async () => {
    const token = await signUp();
    const project = await createProject(token);

    const res = await api(`/api/projects/${project.id}/ws?token=${encodeURIComponent(token)}`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const events: ServerEvent[] = [];
    const waiters: Array<() => void> = [];
    ws.addEventListener("message", (e) => {
      events.push(ServerEvent.parse(JSON.parse(e.data as string)));
      waiters.shift()?.();
    });
    ws.accept();
    const next = () => new Promise<void>((r) => waiters.push(r));

    let pending: Promise<unknown> = Promise.all([next(), next()]);
    ws.send(JSON.stringify({ type: "message.send", clientId: "c1", body: "hello" }));
    await pending;
    expect(events.map((e) => e.type).sort()).toEqual(["message.ack", "message.created"]);
    const created = events.find((e) => e.type === "message.created");
    expect(created?.type === "message.created" && created.message).toMatchObject({
      body: "hello",
      seq: 1,
      projectId: project.id,
      authorKind: "user",
    });

    pending = next();
    ws.send(JSON.stringify({ type: "sync", afterSeq: 0 }));
    await pending;
    const sync = events.at(-1);
    expect(sync?.type === "sync.result" && sync.messages.map((m) => m.body)).toEqual(["hello"]);
    ws.close();
  });

  it("refuses WebSocket for non-members", async () => {
    const project = await createProject(await signUp());
    const stranger = await signUp();
    const res = await api(`/api/projects/${project.id}/ws?token=${encodeURIComponent(stranger)}`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(404);
  });
});

describe("cors", () => {
  it("allows the desktop app origin and exposes the auth token header", async () => {
    const res = await api("/api/health", { headers: { origin: "tauri://localhost" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect(res.headers.get("access-control-expose-headers")).toContain("set-auth-token");

    const preflight = await api("/api/projects", {
      method: "OPTIONS",
      headers: { origin: "http://tauri.localhost", "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
  });

  it("does not allow unknown origins", async () => {
    const res = await api("/api/health", { headers: { origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
