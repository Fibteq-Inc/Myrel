import type { Project } from "@altair/protocol";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "http://altair.test";

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function signUp() {
  const email = `u${crypto.randomUUID()}@example.com`;
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "Test" }),
  });
  return { token: res.headers.get("set-auth-token")!, email };
}

describe("DELETE /api/projects/:id", () => {
  it("lets only owners delete, and removes the project's data", async () => {
    const owner = await signUp();
    const member = await signUp();
    const res = await api("/api/projects", { method: "POST", token: owner.token, body: JSON.stringify({ name: "Gone" }) });
    const { project } = (await res.json()) as { project: Project };
    const base = `/api/projects/${project.id}`;

    // A member, a file, an artifact and a thread with a message.
    const invite = await api(`${base}/invites`, { method: "POST", token: owner.token, body: JSON.stringify({ email: member.email }) });
    const { invite: inv } = (await invite.json()) as { invite: { id: string } };
    await api(`/api/account/invites/${inv.id}/accept`, { method: "POST", token: member.token, body: "{}" });
    expect(
      (await api(`${base}/files/content?path=notes.md`, { token: owner.token, method: "PUT", body: "hello" })).status,
    ).toBe(200);
    const agent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const published = await agent.publishArtifact({ title: "Page", html: "<p>hi</p>", threadId: null });
    expect("artifact" in published).toBe(true);
    const root = await agent.sendMessage({ threadId: null, authorKind: "user", authorId: "u", body: "do it" });
    const thread = await agent.createThread(root.id, "Work");
    await agent.sendMessage({ threadId: thread.id, authorKind: "agent", authorId: "a", body: "on it" });

    expect((await api(base, { method: "DELETE", token: member.token })).status).toBe(403);
    expect((await api(base, { method: "DELETE" })).status).toBe(401);
    expect((await api(base, { method: "DELETE", token: owner.token })).status).toBe(204);

    expect((await api(base, { token: owner.token })).status).toBe(404);
    expect((await api(base, { token: member.token })).status).toBe(404);
    const row = await env.DB.prepare("SELECT count(*) AS n FROM project_members WHERE project_id = ?")
      .bind(project.id)
      .first<{ n: number }>();
    expect(row!.n).toBe(0);
    expect((await env.FILES.list({ prefix: `projects/${project.id}/` })).objects).toEqual([]);
    if ("artifact" in published) {
      expect((await env.ARTIFACTS.list({ prefix: `artifacts/${published.artifact.id}/` })).objects).toEqual([]);
    }
    // The agents' storage is gone.
    const tables = (state: DurableObjectState) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\'").toArray();
    expect(await runInDurableObject(env.PROJECT_AGENT.getByName(project.id), (_, state) => tables(state))).toEqual([]);
    expect(await runInDurableObject(env.THREAD_AGENT.getByName(thread.id), (_, state) => tables(state))).toEqual([]);
    // Two sign-ups plus every store a project touches: slower than the default timeout under a loaded run.
  }, 20_000);

  it("is 404 for strangers", async () => {
    const owner = await signUp();
    const stranger = await signUp();
    const res = await api("/api/projects", { method: "POST", token: owner.token, body: JSON.stringify({ name: "Mine" }) });
    const { project } = (await res.json()) as { project: Project };
    expect((await api(`/api/projects/${project.id}`, { method: "DELETE", token: stranger.token })).status).toBe(404);
  });
});
