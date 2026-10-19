import type { Message, Project, ServerEvent, Task } from "@altair/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { resetFakeModel, setFakeModel } from "./fake-llm";

const BASE = "http://altair.test";

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function until<T>(fn: () => T | Promise<T>, what: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 200; i++) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const call = (name: string, input: unknown) => ({ id: crypto.randomUUID(), name, input });

/** A project with one thread whose agent is ready, and a socket listening to it. */
async function threadSetup() {
  const email = `u${crypto.randomUUID()}@example.com`;
  const signUp = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "İsmail" }),
  });
  const token = signUp.headers.get("set-auth-token")!;
  const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Altair" }) });
  const { project } = (await res.json()) as { project: Project };
  const ws = (await api(`/api/projects/${project.id}/ws?token=${encodeURIComponent(token)}`, {
    headers: { upgrade: "websocket" },
  })).webSocket!;
  const events: ServerEvent[] = [];
  ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string) as ServerEvent));
  ws.accept();

  const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
  const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: "u", body: "testleri çalıştır" });
  const thread = await projectAgent.createThread(root.id, "Testler");
  const threadAgent = await getAgentByName(env.THREAD_AGENT, thread.id);
  return { project, token, ws, events, projectAgent, threadAgent, thread };
}

afterEach(resetFakeModel);

describe("run_task", () => {
  it("runs a task in the thread's sandbox and wakes the agent with its result", async () => {
    const prompts: string[] = [];
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      prompts.push(req.prompt);
      if (!req.prompt.includes("## Tasks")) {
        return {
          text: "",
          toolCalls: [call("run_task", { title: "Testleri çalıştır", prompt: "pnpm test", harness: "shell", language: "tr" })],
        };
      }
      return { text: "", toolCalls: [call("reply", { text: "Sandbox açılamadı." })] };
    });

    const { project, token, ws, events, projectAgent, threadAgent, thread } = await threadSetup();
    await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Run the tests." });

    // The test runtime has no container, so the sandbox reports that and the task fails.
    const bodies = async () => ((await projectAgent.getThreadContext(thread.id))?.messages ?? []).map((m: Message) => m.body);
    await until(async () => (await bodies()).includes("Sandbox açılamadı."), "the agent's reply about the result");

    const [task] = (await threadAgent.getTasks()) as (Task & { log: { text: string }[] })[];
    expect(task).toMatchObject({ title: "Testleri çalıştır", harness: "shell", backend: "sandbox", status: "failed" });
    expect(task!.summary).toContain("container is not configured");
    expect(task!.log.map((l) => l.text)).toContain("Starting Shell in the sandbox…");

    // The second turn saw the result, and the checklist shows where it stopped, in the thread's language.
    expect(prompts[1]).toContain("Testleri çalıştır (failed, NEW result)");
    const t = (await projectAgent.getThread(thread.id))!;
    expect(t.statusText).toContain("✗ Sandbox açılamadı: The sandbox container is not configured");

    // Clients heard about the task and its output live.
    expect(events.some((e) => e.type === "task.updated" && e.task.status === "running")).toBe(true);
    await until(() => events.some((e) => e.type === "task.updated" && e.task.status === "failed"), "task.updated failed");
    expect(events.some((e) => e.type === "task.output" && e.taskId === task!.id)).toBe(true);

    // And can read the history over REST.
    const list = await api(`/api/projects/${project.id}/threads/${thread.id}/tasks`, { token });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { tasks: Task[] }).tasks.map((x) => x.id)).toEqual([task!.id]);
    const missing = await api(`/api/projects/${project.id}/threads/thr_01JZZZZZZZZZZZZZZZZZZZZZZZ/tasks`, { token });
    expect(missing.status).toBe(404);
    ws.close();
  });

  it("reports what it cannot do as a tool error, without starting anything", async () => {
    const { project, ws, threadAgent, thread } = await threadSetup();
    await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "x" });
    const pr = await threadAgent.startTask({ title: "PR", prompt: "fix", repo: "acme/app", openPr: true });
    expect(pr).toMatchObject({ ok: false, error: expect.stringContaining("needs write access") });
    const ssh = await threadAgent.startTask({ title: "x", prompt: "fix", repo: "ssh://git@example.com/x" });
    expect(ssh).toMatchObject({ ok: false, error: expect.stringContaining("not a repository I can clone") });
    expect(await threadAgent.getTasks()).toEqual([]);
    ws.close();
  });
});
