import type { Project } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

const BASE = "http://myrel.test";

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function activity(token: string, id: string) {
  const res = await api("/api/projects", { token });
  const { projects } = (await res.json()) as { projects: Project[] };
  return projects.find((p) => p.id === id)?.activity;
}

describe("project activity", () => {
  it("shows working and waiting threads on the project list", async () => {
    const signUp = await api("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: `u${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "T" }),
    });
    const token = signUp.headers.get("set-auth-token")!;
    const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Myrel" }) });
    const { project } = (await res.json()) as { project: Project };
    expect(project.activity).toEqual({ working: 0, waiting: 0 });

    const agent = await getAgentByName(env.PROJECT_AGENT, project.id);
    const root = await agent.sendMessage({ threadId: null, authorKind: "user", authorId: "x", body: "do it" });
    const a = await agent.createThread(root.id, "First");
    const other = await agent.sendMessage({ threadId: null, authorKind: "user", authorId: "x", body: "and this" });
    const b = await agent.createThread(other.id, "Second");
    await agent.setActivity(null, true);
    await vi.waitFor(async () => expect(await activity(token, project.id)).toEqual({ working: 3, waiting: 0 }));

    await agent.setActivity(null, false);
    await agent.updateThread(a.id, { status: "blocked" });
    await agent.updateThread(b.id, { status: "done", resolved: true });
    await vi.waitFor(async () => expect(await activity(token, project.id)).toEqual({ working: 0, waiting: 1 }));
  });

  it("shows this month's and all-time model cost on the project list", async () => {
    const signUp = await api("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: `u${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "T" }),
    });
    const token = signUp.headers.get("set-auth-token")!;
    const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Costs" }) });
    const { project } = (await res.json()) as { project: Project };

    const now = new Date();
    const lastMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 1;
    const insert = env.DB.prepare(
      `INSERT INTO usage_events (id, created_at, project_id, agent, turn_id, provider, model, input_tokens, output_tokens, cost_micros, latency_ms)
       VALUES (?1, ?2, ?3, 'coordinator', 't', 'openai', 'm', 1, 1, ?4, 1)`,
    );
    await env.DB.batch([
      insert.bind(crypto.randomUUID(), lastMonth, project.id, 2_000_000),
      insert.bind(crypto.randomUUID(), now.getTime(), project.id, 250_000),
      insert.bind(crypto.randomUUID(), now.getTime(), project.id, null),
    ]);

    const list = (await (await api("/api/projects", { token })).json()) as { projects: Project[] };
    expect(list.projects.find((p) => p.id === project.id)?.cost).toEqual({ monthMicros: 250_000, totalMicros: 2_250_000 });
  });
});
