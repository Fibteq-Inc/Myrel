import type { MemoryUpkeepState, Project, Thread } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { UPKEEP_THREADS, upkeepActive, upkeepDue } from "../src/agents/memory-upkeep";
import { MEMORY_UPKEEP_ID } from "../src/agents/names";
import { agentProject, type Turn } from "./fake-agent";

const BASE = "http://myrel.test";

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function signUp() {
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email: `u${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "İsmail" }),
  });
  return res.headers.get("set-auth-token")!;
}

async function until<T>(fn: () => T | Promise<T>, what: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 200; i++) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A thread opened and finished, as if some ask was done. */
async function finishThread(agent: Awaited<ReturnType<typeof projectAgent>>) {
  const root = await agent.sendMessage({ threadId: null, authorKind: "agent", authorId: "coordinator", body: "done" });
  const thread = await agent.createThread(root.id, "Some work");
  await agent.updateThread(thread.id, { resolved: true });
}

const projectAgent = (id: string) => getAgentByName(env.PROJECT_AGENT, id);

describe("memory upkeep timing", () => {
  it("is due after enough threads and not more than once a week", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    expect(upkeepDue({ threadsSince: UPKEEP_THREADS - 1, lastRunAt: null, now })).toBe(false);
    expect(upkeepDue({ threadsSince: UPKEEP_THREADS, lastRunAt: null, now })).toBe(true);
    expect(upkeepDue({ threadsSince: 50, lastRunAt: "2026-10-20T12:00:00Z", now })).toBe(false);
    expect(upkeepDue({ threadsSince: UPKEEP_THREADS, lastRunAt: "2026-10-16T12:00:00Z", now })).toBe(true);
  });

  it("runs on its own in automatic mode only where tasks run locally", () => {
    expect(upkeepActive("auto", true)).toBe(true);
    expect(upkeepActive("auto", false)).toBe(false);
    expect(upkeepActive("on", false)).toBe(true);
    expect(upkeepActive("off", true)).toBe(false);
  });
});

describe("memory upkeep", () => {
  it("opens an upkeep thread on the owner's computer once enough threads finished", async () => {
    const token = await signUp();
    const { project, turns } = await agentProject(token, async (turn: Turn) => {
      await turn.call("reply", { text: "Checked." });
      return "";
    });
    const base = `/api/projects/${project.id}`;
    const agent = await projectAgent(project.id);
    await api(`${base}/memory/deploy`, { token, method: "PUT", body: JSON.stringify({ description: "How deploys work", content: "Workers Builds" }) });

    let upkeep = ((await (await api(`${base}/memory-upkeep`, { token })).json()) as { upkeep: MemoryUpkeepState }).upkeep;
    expect(upkeep).toMatchObject({ mode: "auto", active: true, lastRunAt: null, threadsSince: 0, threadId: null });

    for (let i = 0; i < UPKEEP_THREADS - 1; i++) await finishThread(agent);
    upkeep = await until(async () => {
      const u = await agent.memoryUpkeep();
      return u.threadsSince === UPKEEP_THREADS - 1 ? u : null;
    }, "the count");
    expect(upkeep.threadId).toBeNull();

    await finishThread(agent);
    upkeep = await until(async () => {
      const u = await agent.memoryUpkeep();
      return u.threadId ? u : null;
    }, "the upkeep thread");
    expect(upkeep.threadsSince).toBe(0);
    expect(upkeep.lastRunAt).toBeTruthy();
    const thread = (await agent.getThread(upkeep.threadId!))!;
    expect(thread.title).toBe("Memory upkeep");
    expect((await agent.getMessage(thread.rootMessageId))?.authorId).toBe(MEMORY_UPKEEP_ID);

    // It works for the computer's owner, on their CLI, with the upkeep brief.
    const turn = await until(() => turns.find((t) => t.threadId === thread.id), "the upkeep turn");
    expect(turn.prompt).toContain("Memory upkeep for this project");

    // While it is open, more finished threads do not start a second one, and "check now" says it is running.
    expect((await api(`${base}/memory-upkeep/run`, { token, method: "POST" })).status).toBe(409);
    // Let the turn finish before the runner goes away.
    await until(async () => (await agent.getThread(thread.id))?.status !== "working", "the upkeep turn to end");
  });

  it("stays off in automatic mode for a cloud project, and can be switched or run by hand", async () => {
    const token = await signUp();
    const created = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Cloud" }) });
    const { project } = (await created.json()) as { project: Project };
    const base = `/api/projects/${project.id}`;
    const agent = await projectAgent(project.id);

    // Nothing to check yet.
    expect((await api(`${base}/memory-upkeep/run`, { token, method: "POST" })).status).toBe(409);
    await api(`${base}/memory/pricing`, { token, method: "PUT", body: JSON.stringify({ description: "Prices", content: "10 USD" }) });

    for (let i = 0; i < UPKEEP_THREADS; i++) await finishThread(agent);
    await until(async () => (await agent.memoryUpkeep()).threadsSince === UPKEEP_THREADS, "the count");
    expect(await agent.memoryUpkeep()).toMatchObject({ mode: "auto", active: false, threadId: null });

    expect((await api(`${base}/memory-upkeep`, { token, method: "PUT", body: JSON.stringify({ mode: "sometimes" }) })).status).toBe(400);
    const res = await api(`${base}/memory-upkeep`, { token, method: "PUT", body: JSON.stringify({ mode: "on" }) });
    expect(((await res.json()) as { upkeep: MemoryUpkeepState }).upkeep).toMatchObject({ mode: "on", active: true });

    const run = await api(`${base}/memory-upkeep/run`, { token, method: "POST" });
    expect(run.status).toBe(201);
    const { thread } = (await run.json()) as { thread: Thread };
    expect((await agent.memoryUpkeep()).threadId).toBe(thread.id);

    // People outside the project see nothing of it.
    const other = await signUp();
    expect((await api(`${base}/memory-upkeep`, { token: other })).status).toBe(404);
  });
});
