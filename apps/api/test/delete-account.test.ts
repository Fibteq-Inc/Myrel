import type { Project } from "@altair/protocol";
import { env } from "cloudflare:test";
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
  const { user } = (await res.json()) as { user: { id: string } };
  return { token: res.headers.get("set-auth-token")!, email, id: user.id };
}

async function createProject(token: string, name: string) {
  const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name }) });
  return ((await res.json()) as { project: Project }).project;
}

describe("DELETE /api/account", () => {
  it("deletes the account and its own projects, and hands shared ones on", async () => {
    const leaving = await signUp();
    const staying = await signUp();
    const solo = await createProject(leaving.token, "Solo");
    const shared = await createProject(leaving.token, "Shared");
    const invite = await api(`/api/projects/${shared.id}/invites`, {
      method: "POST",
      token: leaving.token,
      body: JSON.stringify({ email: staying.email }),
    });
    const { invite: inv } = (await invite.json()) as { invite: { id: string } };
    await api(`/api/account/invites/${inv.id}/accept`, { method: "POST", token: staying.token, body: "{}" });

    expect((await api("/api/account", { method: "DELETE" })).status).toBe(401);
    expect((await api("/api/account", { method: "DELETE", token: leaving.token })).status).toBe(204);

    // Signed out everywhere, and the account is gone.
    expect((await api("/api/account", { token: leaving.token })).status).toBe(401);
    const user = await env.DB.prepare("SELECT id FROM user WHERE id = ?").bind(leaving.id).first();
    expect(user).toBeNull();
    const signIn = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: leaving.email, password: "correct-horse-battery" }),
    });
    expect(signIn.ok).toBe(false);

    // The solo project went with it; the shared one now belongs to the remaining member.
    const soloRow = await env.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(solo.id).first();
    expect(soloRow).toBeNull();
    const res = await api(`/api/projects/${shared.id}`, { token: staying.token });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { project: Project }).project.role).toBe("owner");
    const sharedRow = await env.DB.prepare("SELECT created_by AS createdBy FROM projects WHERE id = ?")
      .bind(shared.id)
      .first<{ createdBy: string }>();
    expect(sharedRow!.createdBy).toBe(staying.id);
  }, 20_000);
});
