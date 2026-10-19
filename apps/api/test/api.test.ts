import { API_VERSION, type Message, type Project, ServerEvent, ServerInfo } from "@altair/protocol";
import { getAgentByName } from "agents";
import { createAuth } from "../src/auth";
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

    const members = await (await api(`/api/projects/${project.id}/members`, { token: alice })).json();
    expect(members).toEqual({ members: [expect.objectContaining({ name: "Test", role: "owner" })] });
    expect((await api(`/api/projects/${project.id}/members`, { token: bob })).status).toBe(404);
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
      for (const w of waiters.splice(0)) w();
    });
    ws.accept();
    // Agent activity events may interleave, so wait for the event type we expect.
    const waitFor = async <T extends ServerEvent["type"]>(type: T) => {
      for (;;) {
        const hit = events.find((e) => e.type === type);
        if (hit) return hit as Extract<ServerEvent, { type: T }>;
        await new Promise<void>((r) => waiters.push(r));
      }
    };

    ws.send(JSON.stringify({ type: "message.send", clientId: "c1", body: "hello" }));
    expect(await waitFor("message.ack")).toMatchObject({ clientId: "c1" });
    expect((await waitFor("message.created")).message).toMatchObject({
      body: "hello",
      seq: 1,
      projectId: project.id,
      authorKind: "user",
    });

    ws.send(JSON.stringify({ type: "sync", afterSeq: 0 }));
    const sync = await waitFor("sync.result");
    expect(sync.messages.map((m) => m.body)).toEqual(["hello"]);
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

describe("GET /api/info", () => {
  it("describes the server for connecting apps", async () => {
    const res = await api("/api/info");
    expect(res.status).toBe(200);
    expect(ServerInfo.parse(await res.json())).toMatchObject({
      app: "altair",
      apiVersion: API_VERSION,
      name: "Altair",
      auth: { emailPassword: true, signUp: true },
    });
  });
});

describe("sign-up switch", () => {
  it("refuses new accounts unless SIGNUP_ENABLED is true, but still signs existing users in", async () => {
    const email = `u${crypto.randomUUID()}@example.com`;
    await signUp(email);
    const closed = createAuth({ ...env, SIGNUP_ENABLED: "false" } as Env);
    const req = (path: string, body: unknown) =>
      closed.handler(
        new Request(`${BASE}/api/auth/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE },
          body: JSON.stringify(body),
        }),
      );

    const refused = await req("sign-up/email", { email: `n${email}`, password: "correct-horse-battery", name: "New" });
    expect(refused.ok).toBe(false);
    const signedIn = await req("sign-in/email", { email, password: "correct-horse-battery" });
    expect(signedIn.status).toBe(200);
  });
});
