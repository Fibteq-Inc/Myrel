import type { Artifact, Member, Project } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { emails, resetFakeModel } from "./fake-llm";

const BASE = "http://myrel.test";

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function signUp(name: string) {
  const email = `u${crypto.randomUUID()}@example.com`;
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password: "correct-horse-battery", name }),
  });
  const token = res.headers.get("set-auth-token")!;
  const { user } = (await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } };
  return { token, id: user.id, email };
}

/** A project owned by Olive, with Mel as a member and Ada as a server admin outside it. */
async function setup() {
  const olive = await signUp("Olive");
  const mel = await signUp("Mel");
  const ada = await signUp("Ada");
  // The first account on a server is its admin; here only Ada is.
  await env.DB.prepare("UPDATE user SET role = CASE id WHEN ? THEN 'admin' ELSE 'user' END").bind(ada.id).run();
  const res = await api("/api/projects", { method: "POST", token: olive.token, body: JSON.stringify({ name: "Demo" }) });
  const { project } = (await res.json()) as { project: Project };
  await env.DB.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
    .bind(project.id, mel.id, Date.now())
    .run();
  const agent = await getAgentByName(env.PROJECT_AGENT, project.id);
  emails.length = 0;
  return { olive, mel, ada, project, agent };
}

function report(projectId: string, token: string, body: unknown) {
  return api(`/api/projects/${projectId}/reports`, { method: "POST", token, body: JSON.stringify(body) });
}

afterEach(() => resetFakeModel());

describe("content reports", () => {
  it("keeps a report of a person's message and emails the server's admins and REPORTS_EMAIL", async () => {
    const { olive, mel, ada, project, agent } = await setup();
    const message = await agent.sendMessage({ threadId: null, authorKind: "user", authorId: mel.id, body: "buy cheap pills" });

    const res = await report(project.id, olive.token, {
      target: { kind: "message", messageId: message.id },
      reason: "spam",
      note: "  keeps posting this  ",
    });
    expect(res.status).toBe(201);

    const row = await env.DB.prepare("SELECT * FROM content_reports WHERE target_id = ?").bind(message.id).first();
    expect(row).toMatchObject({
      reporter_id: olive.id,
      project_id: project.id,
      kind: "message",
      author_kind: "user",
      author_id: mel.id,
      reason: "spam",
      note: "keeps posting this",
      excerpt: "buy cheap pills",
    });
    expect(emails.map((e) => e.to).sort()).toEqual([ada.email, env.REPORTS_EMAIL].sort());
    expect(emails[0]!.subject).toBe("[Report] Spam · Demo");
    expect(emails[0]!.text).toContain("buy cheap pills");
    expect(emails[0]!.text).toContain(`Mel <${mel.email}>`);
    expect(emails[0]!.text).toContain(`${BASE}/projects/${project.id}`);

    // Reporting it again files nothing new and sends no more email.
    emails.length = 0;
    const again = await report(project.id, olive.token, { target: { kind: "message", messageId: message.id }, reason: "hate" });
    expect(again.status).toBe(200);
    expect(emails).toEqual([]);
  });

  it("reports an agent's reply and an artifact", async () => {
    const { mel, project, agent } = await setup();
    const reply = await agent.sendMessage({ threadId: null, authorKind: "agent", authorId: "coordinator", body: "Something rude" });
    expect((await report(project.id, mel.token, { target: { kind: "message", messageId: reply.id }, reason: "harassment" })).status).toBe(201);
    expect(emails[0]!.text).toContain("An agent (AI-generated)");

    const published = (await agent.publishArtifact({ title: "Page", html: "<p>hi</p>", threadId: null })) as { artifact: Artifact };
    emails.length = 0;
    const res = await report(project.id, mel.token, {
      target: { kind: "artifact", artifactId: published.artifact.id },
      reason: "other",
    });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare("SELECT version, excerpt FROM content_reports WHERE target_id = ?").bind(published.artifact.id).first();
    expect(row).toEqual({ version: 1, excerpt: 'Artifact "Page", version 1' });
    expect(emails[0]!.text).toContain(`/projects/${project.id}/artifacts/${published.artifact.id}`);
  });

  it("refuses outsiders, unknown content and bad reasons", async () => {
    const { project, agent, olive } = await setup();
    const outsider = await signUp("Out");
    const message = await agent.sendMessage({ threadId: null, authorKind: "user", authorId: olive.id, body: "hello" });
    const target = { kind: "message", messageId: message.id };
    expect((await report(project.id, outsider.token, { target, reason: "spam" })).status).toBe(404);
    expect((await report(project.id, olive.token, { target, reason: "boring" })).status).toBe(400);
    const missing = { kind: "message", messageId: "cmsg_01ARZ3NDEKTSV4RRFFQ69G5FAV" };
    expect((await report(project.id, olive.token, { target: missing, reason: "spam" })).status).toBe(404);
    expect(emails).toEqual([]);
  });

  it("limits how many reports one person files in an hour", async () => {
    const { project, agent, mel } = await setup();
    for (let i = 0; i < 20; i++) {
      const m = await agent.sendMessage({ threadId: null, authorKind: "agent", authorId: "coordinator", body: `reply ${i}` });
      expect((await report(project.id, mel.token, { target: { kind: "message", messageId: m.id }, reason: "spam" })).status).toBe(201);
    }
    const m = await agent.sendMessage({ threadId: null, authorKind: "agent", authorId: "coordinator", body: "one more" });
    expect((await report(project.id, mel.token, { target: { kind: "message", messageId: m.id }, reason: "spam" })).status).toBe(429);
  });
});

describe("blocking members", () => {
  async function members(projectId: string, token: string) {
    return ((await (await api(`/api/projects/${projectId}/members`, { token })).json()) as { members: Member[] }).members;
  }

  it("marks the member blocked for the blocker only and tells the project's owners", async () => {
    const { olive, mel, project } = await setup();
    const third = await signUp("Tess");
    await env.DB.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
      .bind(project.id, third.id, Date.now())
      .run();

    const res = await api(`/api/projects/${project.id}/blocks/${mel.id}`, { method: "PUT", token: third.token });
    expect(res.status).toBe(200);
    expect((await members(project.id, third.token)).find((m) => m.id === mel.id)?.blocked).toBe(true);
    // Nobody else's view changes.
    expect((await members(project.id, olive.token)).some((m) => m.blocked)).toBe(false);
    expect(emails.map((e) => e.to)).toEqual([olive.email]);
    expect(emails[0]!.subject).toBe("[Demo] Tess blocked Mel");

    // Blocking again tells nobody twice; unblocking clears it.
    emails.length = 0;
    expect((await api(`/api/projects/${project.id}/blocks/${mel.id}`, { method: "PUT", token: third.token })).status).toBe(200);
    expect(emails).toEqual([]);
    expect((await api(`/api/projects/${project.id}/blocks/${mel.id}`, { method: "DELETE", token: third.token })).status).toBe(204);
    expect((await members(project.id, third.token)).some((m) => m.blocked)).toBe(false);
  });

  it("does not email the blocker about their own block, and refuses self and outsiders", async () => {
    const { olive, mel, project } = await setup();
    expect((await api(`/api/projects/${project.id}/blocks/${mel.id}`, { method: "PUT", token: olive.token })).status).toBe(200);
    expect(emails).toEqual([]);
    expect((await api(`/api/projects/${project.id}/blocks/${olive.id}`, { method: "PUT", token: olive.token })).status).toBe(400);
    const outsider = await signUp("Out");
    expect((await api(`/api/projects/${project.id}/blocks/${outsider.id}`, { method: "PUT", token: olive.token })).status).toBe(404);
    expect((await api(`/api/projects/${project.id}/blocks/${mel.id}`, { method: "PUT", token: outsider.token })).status).toBe(404);
  });
});
