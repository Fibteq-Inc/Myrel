import { formatPlan, type Message, planChecklist, type Project, type ServerEvent, type Task } from "@altair/protocol";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadAgent } from "../src/agents/thread-agent";
import { readWorkspace, threadWorkspace } from "../src/sandbox/workspace";
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
          toolCalls: [
            call("update_plan", {
              title: "Testler",
              steps: [
                { text: "Testleri çalıştır", state: "active" },
                { text: "Sonucu bildir", state: "todo" },
              ],
            }),
            call("run_task", { title: "Testleri çalıştır", prompt: "pnpm test", harness: "shell", language: "tr" }),
          ],
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
    // The task's steps sit under the agent's own plan step.
    expect(t.statusText).toMatch(/^Testler\n\n✱ Testleri çalıştır\n {2}✗ Sandbox açılamadı: The sandbox container is not configured/);
    expect(t.statusText).toContain("\n○ Sonucu bildir");
    // The conversation has one plan card for it, holding the same steps.
    const cards = (await bodies()).filter((b) => planChecklist(b) !== null);
    expect(cards).toEqual([formatPlan(t.statusText!)]);

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

  it("nudges a silent agent once after a failed task, then reports it and hands it to the coordinator", async () => {
    const prompts: string[] = [];
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      prompts.push(req.prompt);
      if (prompts.length > 1) return { text: "", toolCalls: [] };
      return {
        text: "",
        toolCalls: [call("run_task", { title: "Komutları çalıştır", prompt: "ls demo", harness: "shell", language: "tr" })],
      };
    });

    const { project, ws, projectAgent, threadAgent, thread } = await threadSetup();
    await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Run it." });

    const bodies = async () => ((await projectAgent.getThreadContext(thread.id))?.messages ?? []).map((m: Message) => m.body);
    const report = await until(
      async () => (await bodies()).find((b) => b.startsWith('"Komutları çalıştır" görevi başarısız oldu.')),
      "the thread's own report",
    );
    expect(report).toContain("container is not configured");
    // One more turn carried the nudge, and only one: then the thread reported it itself.
    const nudge = 'The task "Komutları çalıştır" failed and you ended your turn without telling the person.';
    expect(prompts.filter((p) => p.includes(nudge))).toHaveLength(1);
    await until(async () => (await projectAgent.getThread(thread.id))!.status === "blocked", "the thread to wait on the coordinator");
    ws.close();
  });

  it("puts back steps marked done with no work behind them and makes the agent do the work", async () => {
    const prompts: string[] = [];
    setFakeModel((req) => {
      if (req.turns > 1 || !req.prompt.includes("Hesap makinesi")) return { text: "", toolCalls: [] };
      prompts.push(req.prompt);
      if (prompts.length === 1) {
        // Claims the whole plan without doing anything.
        return {
          text: "",
          toolCalls: [
            call("reply", { text: "Hesap makinesini oluşturuyorum." }),
            call("update_plan", {
              title: "Hesap makinesi",
              steps: [
                { text: "Dosyayı oluştur", state: "done" },
                { text: "Sonucu bildir", state: "done" },
              ],
            }),
          ],
        };
      }
      if (prompts.length === 2) {
        return { text: "", toolCalls: [call("run_task", { title: "Hesap makinesi", prompt: "touch calc.html", harness: "shell" })] };
      }
      return { text: "", toolCalls: [call("reply", { text: "Görev çalışmadı." })] };
    });

    const { project, ws, projectAgent, threadAgent, thread } = await threadSetup();
    await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Hesap makinesi yap." });

    await until(async () => (await threadAgent.getTasks()).length === 1, "the task the nudge led to");
    expect(prompts[1]).toContain('You marked "Dosyayı oluştur", "Sonucu bildir" done, but nothing was done this turn');
    // The unearned steps went back before the agent worked on them again.
    expect(prompts[1]).toContain("✱ Dosyayı oluştur");
    expect(prompts[1]).toContain("○ Sonucu bildir");
    const bodies = async () => ((await projectAgent.getThreadContext(thread.id))?.messages ?? []).map((m: Message) => m.body);
    await until(async () => (await bodies()).includes("Görev çalışmadı."), "the reply about the task");
    ws.close();
  });

  it("gives an agent that stopped after its opening note one more turn to start the work", async () => {
    const prompts: string[] = [];
    setFakeModel((req) => {
      if (req.turns > 1 || !req.prompt.includes("Hesap makinesi")) return { text: "", toolCalls: [] };
      prompts.push(req.prompt);
      // Says it is starting, then stops.
      if (prompts.length === 1) return { text: "", toolCalls: [call("reply", { text: "Başlıyorum." })] };
      if (prompts.length === 2) {
        return { text: "", toolCalls: [call("run_task", { title: "Hesap makinesi", prompt: "touch calc.html", harness: "shell" })] };
      }
      return { text: "", toolCalls: [call("reply", { text: "Görev çalışmadı." })] };
    });

    const { project, ws, projectAgent, threadAgent, thread } = await threadSetup();
    await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Hesap makinesi yap." });

    await until(async () => (await threadAgent.getTasks()).length === 1, "the task the nudge led to");
    expect(prompts[1]).toContain("Your last turn ended right after your reply, with no plan, no task and nothing asked.");
    const bodies = async () => ((await projectAgent.getThreadContext(thread.id))?.messages ?? []).map((m: Message) => m.body);
    await until(async () => (await bodies()).includes("Görev çalışmadı."), "the reply about the task");
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
        repos.set(name, { remote: `https://artifacts.example/altair/${name}.git` });
        return {};
      },
    };
    const ws = await threadWorkspace({ WORKSPACES } as unknown as Env, "thr_1", 2100);
    expect(ws).toEqual({ remote: "https://artifacts.example/altair/thread-thr_1.git", token: `art_v1_${"a".repeat(40)}` });
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
    expect(await readWorkspace(env, "thr_1", "altair/other")).toBeNull();
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
