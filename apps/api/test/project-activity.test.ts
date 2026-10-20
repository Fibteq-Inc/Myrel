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
});
