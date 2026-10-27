import type { Project } from "@myrel/protocol";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "http://myrel.test";

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function signUp() {
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email: `u${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "T" }),
  });
  const body = (await res.json()) as { user: { id: string } };
  return { token: res.headers.get("set-auth-token")!, id: body.user.id };
}

async function create(token: string, name: string) {
  const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name }) });
  return ((await res.json()) as { project: Project }).project;
}

async function list(token: string) {
  const { projects } = (await (await api("/api/projects", { token })).json()) as { projects: Project[] };
  return projects.map((p) => `${p.name}${p.pinned ? "*" : ""}`);
}

const pin = (token: string, id: string, pinned: boolean) =>
  api(`/api/projects/${id}/pin`, { method: "PUT", token, body: JSON.stringify({ pinned }) });

describe("project pins", () => {
  it("lists pinned projects first, per person", async () => {
    const me = await signUp();
    const other = await signUp();
    const a = await create(me.token, "A");
    const b = await create(me.token, "B");
    const c = await create(me.token, "C");
    await env.DB.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?1, ?2, 'member', ?3)")
      .bind(a.id, other.id, Date.now())
      .run();
    expect(await list(me.token)).toEqual(["C", "B", "A"]);

    const res = await pin(me.token, a.id, true);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { project: Project }).project.pinned).toBe(true);
    await pin(me.token, b.id, true);
    expect(await list(me.token)).toEqual(["A*", "B*", "C"]);
    // Someone else in the same project keeps their own list.
    expect(await list(other.token)).toEqual(["A"]);

    await pin(me.token, a.id, false);
    expect(await list(me.token)).toEqual(["B*", "C", "A"]);
    expect((await api(`/api/projects/${c.id}`, { token: me.token }).then((r) => r.json())) as { project: Project }).toMatchObject({
      project: { pinned: false },
    });
  });

  it("refuses projects the person is not in and bad input", async () => {
    const me = await signUp();
    const stranger = await signUp();
    const p = await create(me.token, "Mine");
    expect((await pin(stranger.token, p.id, true)).status).toBe(404);
    expect((await api(`/api/projects/${p.id}/pin`, { method: "PUT", token: me.token, body: "{}" })).status).toBe(400);
  });
});
