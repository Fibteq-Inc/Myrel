import { type Message, type Project, type ServerEvent, type Task } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { hashAgentToken } from "../src/agents/harness-agent";
import type { ThreadAgent } from "../src/agents/thread-agent";
import { readWorkspace, threadWorkspace } from "../src/sandbox/workspace";
import { resetFakeModel } from "./fake-llm";

const BASE = "http://myrel.test";

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

/** A project with one thread whose agent is ready, and a socket listening to it. */
async function threadSetup() {
  const email = `u${crypto.randomUUID()}@example.com`;
  const signUp = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "İsmail" }),
  });
  const token = signUp.headers.get("set-auth-token")!;
  const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Myrel" }) });
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

describe("the cloud agent", () => {
  it("does not start a sandbox for someone who has not verified their address", async () => {
    const { project, projectAgent } = await threadSetup();
    const email = `x${crypto.randomUUID()}@example.com`;
    const signUp = await api("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "X" }),
    });
    const { user } = (await signUp.json()) as { user: { id: string } };
    await env.DB.prepare("UPDATE user SET email_verified = 0 WHERE id = ?").bind(user.id).run();
    // A member of the project: a thread works only for its members.
    await env.DB.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
      .bind(project.id, user.id, Date.now())
      .run();
    const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: user.id, body: "çalıştır" });
    const thread = await projectAgent.createThread(root.id, "Doğrulanmamış");
    const threadAgent = await getAgentByName(env.THREAD_AGENT, thread.id);
    await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Run it." });
    await until(async () => (await projectAgent.getThread(thread.id))?.status === "failed", "failed");
    const bodies = ((await projectAgent.getThreadContext(thread.id))?.messages ?? []).map((m: Message) => m.body);
    expect(bodies.some((b) => b.includes("Verify your email address first"))).toBe(true);
    expect(await threadAgent.getTasks()).toEqual([]);
  });

  it("runs a cloud turn with the CLI picked for the thread when the model suits it, else OpenCode and says why", async () => {
    const { project, projectAgent } = await threadSetup();
    const run = async (cli: "codex" | "claude") => {
      const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: "u", body: `testleri ${cli} ile çalıştır` });
      const t = await projectAgent.createThread(root.id, cli, null, undefined, { id: cli, options: [cli], by: "person", reason: null });
      const agent = await getAgentByName(env.THREAD_AGENT, t.id);
      await agent.start({ projectId: project.id, threadId: t.id, brief: "Run the tests." });
      const [task] = await until(async () => {
        const tasks = (await agent.getTasks()) as (Task & { log: { text: string }[] })[];
        return tasks[0]?.status === "failed" ? tasks : null;
      }, `the ${cli} turn`);
      const spec = await runInDurableObject(agent as unknown as DurableObjectStub, (_, state) =>
        JSON.parse(state.storage.sql.exec<{ spec: string }>("SELECT spec FROM tasks").one().spec),
      );
      return { task: task!, spec };
    };
    // The project's model (Fireworks) speaks the OpenAI API: Codex takes it.
    const codex = await run("codex");
    expect(codex.task).toMatchObject({ title: "Codex", harness: "codex", backend: "sandbox" });
    expect(codex.spec.prompt).toContain("You run as Codex in this thread's own Linux sandbox");
    // Fireworks serves its models over Anthropic's Messages API too: Claude Code takes it as well.
    const claude = await run("claude");
    expect(claude.task).toMatchObject({ title: "Claude Code", harness: "claude-code" });
    expect(claude.spec.model).toMatchObject({ provider: "fireworks", messages: true });
  });

  it("runs the thread's agent as OpenCode in its sandbox, connected to the thread's MCP endpoint", async () => {
    const { project, token, ws, events, projectAgent, threadAgent, thread } = await threadSetup();
    await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Run the tests." });

    // The test runtime has no container, so the sandbox reports that and the turn fails.
    const [task] = await until(async () => {
      const tasks = (await threadAgent.getTasks()) as (Task & { log: { text: string }[] })[];
      return tasks[0]?.status === "failed" ? tasks : null;
    }, "the failed turn");
    expect(task).toMatchObject({ title: "OpenCode", harness: "opencode", backend: "sandbox" });
    expect(task!.summary).toContain("container is not configured");
    expect(task!.log.map((l) => l.text)).toContain("Starting OpenCode in the sandbox…");

    // What the sandbox was handed: Myrel's instructions and the thread, the model, and where to call back.
    const spec = await runInDurableObject(threadAgent as unknown as DurableObjectStub, (_, state) =>
      JSON.parse(state.storage.sql.exec<{ spec: string }>("SELECT spec FROM tasks").one().spec),
    );
    expect(spec).toMatchObject({ agent: true, mcp: { url: `http://myrel.test/api/agent-mcp/${thread.id}` }, model: { provider: "fireworks" } });
    expect(spec.prompt).toContain("You run as OpenCode in this thread's own Linux sandbox");

    // The person hears what happened, in the thread's language.
    const bodies = async () => ((await projectAgent.getThreadContext(thread.id))?.messages ?? []).map((m: Message) => m.body);
    const report = await until(async () => (await bodies()).find((b) => b.startsWith('"OpenCode" görevi başarısız oldu.')), "the report");
    expect(report).toContain("container is not configured");
    // The report carries the turn's line: OpenCode in the cloud, with the project's model.
    const reported = ((await projectAgent.getThreadContext(thread.id))?.messages ?? []).find((m: Message) => m.body === report)!;
    expect(reported.stats).toMatchObject({ runtime: "cloud", harness: "opencode", model: spec.model.id });
    await until(async () => (await projectAgent.getThread(thread.id))?.status === "failed", "failed");

    // Clients heard about the run and its output live.
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

  it("ends a turn its sandbox lost (a deploy restarted it), on Stop or on its own check", async () => {
    const { project, threadAgent, thread } = await threadSetup();
    await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Run the tests." });
    await until(async () => ((await threadAgent.getTasks())[0]?.status === "failed" ? true : null), "the first turn");

    // Runs the sandbox does not know, like ones a deploy cut off mid-way.
    const lost = (id: string, agent = false) =>
      runInDurableObject(threadAgent as unknown as DurableObjectStub, (_, state) => {
        const spec = { taskId: id, title: "OpenCode", prompt: "x", harness: "opencode", openPr: false, timeoutSec: 60, ...(agent && { agent }) };
        const progress = { phases: { prepare: "started", clone: "pending", agent: "pending", save: "skipped", publish: "pending" }, phaseDetail: {}, todos: [], lastText: null, lastTool: null, prUrl: null, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, finished: null };
        state.storage.sql.exec(
          "INSERT INTO tasks (id, spec, backend, status, progress, language, created_at) VALUES (?, ?, 'sandbox', 'running', ?, 'en', ?)",
          id, JSON.stringify(spec), JSON.stringify(progress), new Date().toISOString(),
        );
      });
    const status = async (id: string) => (await threadAgent.getTasks()).find((t) => t.id === id)?.status;

    await lost("task_stop");
    expect(await threadAgent.cancelTask("task_stop")).toEqual({ ok: true });
    expect(await status("task_stop")).toBe("cancelled");

    await lost("task_check");
    await threadAgent.sandboxCheck({ taskId: "task_check" });
    const task = (await threadAgent.getTasks()).find((t) => t.id === "task_check")!;
    expect(task.status).toBe("failed");
    expect(task.summary).toContain("new version of Myrel was deployed");

    // An agent turn the sandbox lost continues on its own, like one a runner restart cut off.
    await lost("task_turn", true);
    await threadAgent.sandboxCheck({ taskId: "task_turn" });
    expect(await status("task_turn")).toBe("failed");
    const resumes = await runInDurableObject(threadAgent as unknown as DurableObjectStub, (agent: ThreadAgent) =>
      agent.getSchedules().filter((x) => x.callback === "resumeInterrupted"),
    );
    expect(resumes.map((x) => x.payload)).toEqual([{ taskId: "task_turn" }]);
  }, 20_000);

  it("opens the model proxy to a cloud turn's token only, never a local turn's", async () => {
    const { project, thread, threadAgent } = await threadSetup();
    const running = (backend: string) =>
      runInDurableObject(threadAgent as unknown as DurableObjectStub, async (_, state) => {
        const sql = state.storage.sql;
        sql.exec("DELETE FROM tasks");
        const spec = { taskId: `task_${backend}`, title: "x", prompt: "x", harness: "opencode", openPr: false, timeoutSec: 60 };
        sql.exec(
          "INSERT INTO tasks (id, spec, backend, status, progress, language, created_at) VALUES (?, ?, ?, 'running', '{}', 'en', ?)",
          spec.taskId, JSON.stringify(spec), backend, new Date().toISOString(),
        );
        const meta = { agent_token: await hashAgentToken("tok"), project_id: project.id, thread_id: thread.id };
        for (const [key, value] of Object.entries(meta)) {
          sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
        }
      });
    await running("local");
    expect(await threadAgent.modelCaller("tok")).toBeNull();
    await running("sandbox");
    expect(await threadAgent.modelCaller("tok")).toMatchObject({ taskId: "task_sandbox" });
    expect(await threadAgent.modelCaller("other")).toBeNull();
  });

  it("learns the address the sandbox calls back on when someone opens the project", async () => {
    const { ws, projectAgent } = await threadSetup();
    ws.close();
    expect(await projectAgent.publicOrigin()).toBe("http://myrel.test");
    // A project nobody opened yet does not know it, so its cloud turns say so instead of starting.
    const other = await getAgentByName(env.PROJECT_AGENT, `proj_${crypto.randomUUID()}`);
    expect(await other.publicOrigin()).toBeNull();
  });

  it("tells clients a thread stopped even when the project forgot it was working", async () => {
    const { ws, events, projectAgent, thread } = await threadSetup();
    // As after an eviction mid-turn: the in-memory activity is gone, but clients still show it.
    await projectAgent.setActivity(thread.id, false);
    await until(() => events.some((e) => e.type === "agent.activity" && e.threadId === thread.id && !e.active), "the stop");
    ws.close();
  });
});

describe("thread workspace", () => {
  it("creates the thread's repository once and hands out a bare write token", async () => {
    const repos = new Map<string, { remote: string }>();
    const tokens: [string, number][] = [];
    const notFound = Object.assign(new Error("missing"), { code: "NOT_FOUND" });
    const WORKSPACES = {
      get: async (name: string) => {
        const repo = repos.get(name);
        if (!repo) throw notFound;
        return {
          info: async () => ({ remote: repo.remote }),
          createToken: async (scope: string, ttl: number) => {
            tokens.push([scope, ttl]);
            return { plaintext: `art_v1_${"a".repeat(40)}?expires=1760000000` };
          },
        };
      },
      create: async (name: string) => {
        repos.set(name, { remote: `https://artifacts.example/myrel/${name}.git` });
        return {};
      },
    };
    const ws = await threadWorkspace({ WORKSPACES } as unknown as Env, "thr_1", 2100);
    expect(ws).toEqual({ remote: "https://artifacts.example/myrel/thread-thr_1.git", token: `art_v1_${"a".repeat(40)}` });
    await threadWorkspace({ WORKSPACES } as unknown as Env, "thr_1", 2100);
    expect([...repos.keys()]).toEqual(["thread-thr_1"]);
    expect(tokens).toEqual([["write", 2100], ["write", 2100]]);

    // Without the binding, or when Artifacts fails, tasks run without saving.
    expect(await threadWorkspace({} as Env, "thr_1", 60)).toBeNull();
    const broken = { get: async () => { throw new Error("down"); } };
    expect(await threadWorkspace({ WORKSPACES: broken } as unknown as Env, "thr_1", 60)).toBeNull();
  });
});

describe("reading a thread's workspace", () => {
  it("lists folders, reads files and returns the history, without a sandbox", async () => {
    const trees: Record<string, ArtifactsTreeEntry[]> = {
      root: [
        { name: "src", mode: "40000", hash: "t-src", type: "tree" },
        { name: "README.md", mode: "100644", hash: "b-readme", type: "blob" },
        { name: "logo.png", mode: "100644", hash: "b-png", type: "blob" },
      ],
      "t-src": [{ name: "index.ts", mode: "100644", hash: "b-index", type: "blob" }],
    };
    const blobs: Record<string, Uint8Array> = {
      "b-readme": new TextEncoder().encode("# Demo\n"),
      "b-index": new TextEncoder().encode("export {};\n"),
      "b-png": new Uint8Array([137, 80, 0, 1]),
    };
    const refs: string[] = [];
    const repo = {
      log: async ({ ref }: { ref: string }) => {
        refs.push(ref);
        return ref === "main" ? [{ hash: "c2", treeHash: "root", message: "Second", committedAt: 1760000100 }] : [];
      },
      readTree: async (hash: string) => trees[hash] ?? null,
      readBlob: async (hash: string) => (blobs[hash] ? new Blob([blobs[hash]!]) : null),
    };
    const notFound = Object.assign(new Error("missing"), { code: "NOT_FOUND" });
    const env = {
      WORKSPACES: { get: async (name: string) => { if (name !== "thread-thr_1") throw notFound; return repo; } },
    } as unknown as Env;

    const root = await readWorkspace(env, "thr_1", "main");
    expect(root).toMatchObject({
      ref: "main",
      commits: [{ hash: "c2", message: "Second", at: "2025-10-09T08:55:00.000Z" }],
      entries: [
        { name: "src", path: "src", type: "folder" },
        { name: "logo.png", path: "logo.png", type: "file" },
        { name: "README.md", path: "README.md", type: "file" },
      ],
      file: null,
    });
    expect((await readWorkspace(env, "thr_1", "main", "src"))!.entries).toEqual([{ name: "index.ts", path: "src/index.ts", type: "file" }]);
    expect((await readWorkspace(env, "thr_1", "main", "src/index.ts"))!.file).toEqual({
      path: "src/index.ts", text: "export {};\n", size: 11, truncated: false,
    });
    expect((await readWorkspace(env, "thr_1", "main", "logo.png"))!.file).toMatchObject({ text: null, size: 4 });
    // Paths cannot climb out, and missing ones say so.
    expect((await readWorkspace(env, "thr_1", "main", "../README.md"))!.file?.path).toBe("README.md");
    expect(await readWorkspace(env, "thr_1", "main", "nope")).toMatchObject({ entries: null, file: null });
    // Nothing saved on the branch, no repository, or no binding: nothing to show.
    expect(await readWorkspace(env, "thr_1", "myrel/other")).toBeNull();
    expect(await readWorkspace(env, "thr_2", "main")).toBeNull();
    expect(await readWorkspace({} as Env, "thr_1", "main")).toBeNull();
  });
});

describe("tasks from before run_task", () => {
  it("moves a thread's older local tasks into the tasks table", async () => {
    const stub = env.THREAD_AGENT.get(env.THREAD_AGENT.idFromName(`thr_${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (instance: ThreadAgent, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE tasks");
      sql.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, runner_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
        result TEXT, created_at TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0)`);
      sql.exec("INSERT INTO tasks VALUES ('task_1', 'rnr_1', 'Run pnpm test\nand report', 'done', '12 passed', '2026-10-19T10:00:00.000Z', 1)");
      (instance as unknown as { migrateLocalTasks(): void }).migrateLocalTasks();
      expect(instance.getTasks()).toMatchObject([
        { id: "task_1", title: "Run pnpm test", backend: "local", status: "done", summary: "12 passed", log: [] },
      ]);
    });
  });
});
