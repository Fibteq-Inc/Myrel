import type { Notification, Project, Routine, ServerEvent, Thread } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { agentProject, modelAgent } from "./fake-agent";
import { emails as sentEmails, type FakeRequest, resetFakeModel, setFakeModel } from "./fake-llm";

const BASE = "http://myrel.test";

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function setup() {
  const email = `u${crypto.randomUUID()}@example.com`;
  const signUp = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "İsmail" }),
  });
  const token = signUp.headers.get("set-auth-token")!;
  // Its threads are worked by the fake model, as the person's CLI (see fake-agent.ts).
  const { project } = await agentProject(token, modelAgent);
  const ws = (
    await api(`/api/projects/${project.id}/ws?token=${encodeURIComponent(token)}`, {
      headers: { upgrade: "websocket" },
    })
  ).webSocket!;
  const events: ServerEvent[] = [];
  ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string) as ServerEvent));
  ws.accept();
  const agent = await getAgentByName(env.PROJECT_AGENT, project.id);
  return { email, token, project, ws, events, agent };
}

async function until<T>(fn: () => T | Promise<T>, what: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 160; i++) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const call = (name: string, input: unknown) => ({ id: crypto.randomUUID(), name, input });
const isCoordinator = (r: FakeRequest) => r.system.includes("coordinator of a shared project chat");
const newMessageId = (prompt: string) => /\[(cmsg_[0-9A-Z]{26})\][^\n]*· NEW/.exec(prompt)?.[1];
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

afterEach(resetFakeModel);

/** Waits until the thread has no turn running and none pending, so no work outlives the test. */
async function settled(threadAgent: unknown) {
  await until(
    () =>
      runInDurableObject(threadAgent as DurableObjectStub, (_, state) => {
        const running = state.storage.sql.exec("SELECT id FROM tasks WHERE status = 'running'").toArray().length;
        const dirty = state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'dirty'").toArray()[0]?.value === "1";
        return running === 0 && !dirty;
      }),
    "the thread to settle",
  );
}

describe("routines", () => {
  it("lets members create, pause, resume and delete routines over the API", async () => {
    const { token, project, ws, events } = await setup();
    const path = `/api/projects/${project.id}/routines`;

    const bad = await api(path, {
      method: "POST",
      token,
      body: JSON.stringify({ name: "x", prompt: "y", schedule: { kind: "cron", cron: "nope" } }),
    });
    expect(bad.status).toBe(400);
    const past = await api(path, {
      method: "POST",
      token,
      body: JSON.stringify({ name: "x", prompt: "y", schedule: { kind: "once", at: "2020-01-01T00:00:00Z" } }),
    });
    expect(past.status).toBe(400);

    const created = await api(path, {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "Morning digest",
        prompt: "Summarize yesterday's threads.",
        schedule: { kind: "cron", cron: "0 9 * * 1-5", timezone: "Europe/Istanbul" },
      }),
    });
    expect(created.status).toBe(201);
    const { routine } = (await created.json()) as { routine: Routine };
    expect(routine).toMatchObject({
      name: "Morning digest",
      paused: false,
      target: { kind: "coordinator" },
      runCount: 0,
    });
    // 09:00 in Istanbul is 06:00 UTC, on a weekday.
    const next = new Date(routine.nextRunAt!);
    expect(next.getUTCHours()).toBe(6);
    expect([1, 2, 3, 4, 5]).toContain(next.getUTCDay());

    expect((await json<{ routines: Routine[] }>(api(path, { token }))).routines.map((r) => r.id)).toEqual([routine.id]);
    await until(() => events.some((e) => e.type === "routine.updated" && e.routine.id === routine.id), "live event");

    const paused = await json<{ routine: Routine }>(
      api(`${path}/${routine.id}`, { method: "PATCH", token, body: JSON.stringify({ paused: true }) }),
    );
    expect(paused.routine).toMatchObject({ paused: true, nextRunAt: null });
    const resumed = await json<{ routine: Routine }>(
      api(`${path}/${routine.id}`, { method: "PATCH", token, body: JSON.stringify({ paused: false }) }),
    );
    expect(resumed.routine.nextRunAt).toBe(routine.nextRunAt);

    // Someone outside the project cannot see or touch them.
    const other = (
      await api("/api/auth/sign-up/email", {
        method: "POST",
        body: JSON.stringify({
          email: `o${crypto.randomUUID()}@example.com`,
          password: "correct-horse-battery",
          name: "O",
        }),
      })
    ).headers.get("set-auth-token")!;
    expect((await api(path, { token: other })).status).toBe(404);

    expect((await api(`${path}/${routine.id}`, { method: "DELETE", token })).status).toBe(200);
    expect((await api(`${path}/${routine.id}`, { method: "DELETE", token })).status).toBe(404);
    await until(() => events.some((e) => e.type === "routine.deleted" && e.routineId === routine.id), "delete event");
    ws.close();
  });

  it("posts a project-chat run that the coordinator routes into a thread", async () => {
    setFakeModel((req) => {
      if (req.turns > 1 || !isCoordinator(req)) return { text: "", toolCalls: [] };
      const ran = /Routine \[rtn_[0-9A-Z]{26}\] "[^"]*" ran and posted \[(cmsg_[0-9A-Z]{26})\]/.exec(req.prompt)?.[1];
      if (!ran) return { text: "", toolCalls: [] };
      return {
        text: "",
        toolCalls: [
          call("start_thread", { message_id: ran, title: "Daily digest", instructions: "Write the digest." }),
        ],
      };
    });
    const { token, project, ws, agent } = await setup();
    const { routine } = await json<{ routine: Routine }>(
      api(`/api/projects/${project.id}/routines`, {
        method: "POST",
        token,
        body: JSON.stringify({
          name: "Daily digest",
          prompt: "Write today's digest.",
          schedule: { kind: "cron", cron: "0 18 * * *" },
        }),
      }),
    );

    // The alarm callback: run, then re-arm for the next match.
    await agent.runRoutine({ routineId: routine.id });
    const thread: Thread = await until(async () => (await agent.listThreads())[0], "thread for the run");
    expect(thread.title).toBe("Daily digest");
    const root = (await agent.getMessage(thread.rootMessageId))!;
    expect(root).toMatchObject({ authorKind: "system", authorId: "routine" });
    expect(root.body).toContain("Write today's digest.");

    const after = (await agent.getRoutine(routine.id))!;
    expect(after.runCount).toBe(1);
    expect(after.lastRunAt).not.toBeNull();
    expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(Date.now());
    ws.close();
  });

  it("lets a thread agent schedule a routine that wakes its own thread, and notifies on the result", async () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    setFakeModel((req) => {
      if (req.turns > 1) return { text: "", toolCalls: [] };
      if (isCoordinator(req)) {
        const id = newMessageId(req.prompt);
        return id
          ? {
              text: "",
              toolCalls: [
                call("start_thread", { message_id: id, title: "Reminder", instructions: "Remind me in an hour.", project_ack: "On it." }),
              ],
            }
          : { text: "", toolCalls: [] };
      }
      if (req.prompt.includes("## Routine runs") && req.prompt.includes("· NEW")) {
        return { text: "", toolCalls: [call("reply", { text: "Saat geldi: **toplantı** var." })] };
      }
      return {
        text: "",
        toolCalls: [
          call("create_routine", { name: "Meeting reminder", prompt: "Remind them about the meeting.", at }),
          call("reply", { text: "Bir saat sonra hatırlatacağım. Hangi saat dilimi? İstanbul mu?", needs: "decision" }),
        ],
      };
    });
    const { token, ws, agent } = await setup();
    ws.send(JSON.stringify({ type: "message.send", body: "bir saat sonra hatırlat" }));

    const routine: Routine = await until(async () => (await agent.listRoutines())[0], "routine from the thread agent");
    const thread: Thread = (await agent.listThreads())[0]!;
    // It works for the person the turn worked for.
    const me = (await json<{ user: { id: string } }>(api("/api/auth/get-session", { token }))).user.id;
    expect(routine).toMatchObject({
      createdBy: me,
      target: { kind: "thread", threadId: thread.id },
      nextRunAt: at,
    });

    // The reply that asked a question notified as a decision, by email too.
    const list = async () =>
      json<{ notifications: Notification[]; unread: number }>(api("/api/notifications", { token }));
    const first = await until(async () => (await list()).notifications[0], "decision notification");
    expect(first).toMatchObject({ kind: "decision", title: "Reminder", threadId: thread.id });
    expect(first.url).toBe(`/projects/${thread.projectId}/threads/${thread.id}`);
    // Filtered by subject: a late turn from an earlier test's thread can also send mail here.
    const emails = () => sentEmails.filter((e) => e.subject.endsWith("· Reminder"));
    const sent = emails()[0]!;
    expect(sent.subject).toBe("[Myrel] Needs your decision · Reminder");
    expect(sent.from).toEqual({ name: "Myrel", email: "myrel@example.com" });
    expect(sent.html).toContain(`http://myrel.test/projects/${thread.projectId}/threads/${thread.id}`);

    // The one-off run wakes the thread; afterwards nothing is left to schedule.
    await agent.runRoutine({ routineId: routine.id });
    const ready = await until(async () => {
      const n = (await list()).notifications;
      return n.find((x) => x.kind === "ready");
    }, "ready notification");
    expect(ready.body).toBe("Saat geldi: toplantı var.");
    expect(await agent.getRoutine(routine.id)).toMatchObject({ runCount: 1, nextRunAt: null });
    // "ready" does not send email.
    expect(emails()).toHaveLength(1);

    expect((await list()).unread).toBe(2);
    await api("/api/notifications/read", { method: "POST", token, body: JSON.stringify({ ids: [first.id] }) });
    expect((await list()).unread).toBe(1);
    await api("/api/notifications/read", { method: "POST", token, body: JSON.stringify({ all: true }) });
    expect((await list()).unread).toBe(0);
    ws.close();
  });

  it("runs a member's routine on someone else's thread as that member, not as the thread's person", async () => {
    const { token, project, ws, agent } = await setup();
    ws.close();
    const owner = (await json<{ user: { id: string } }>(api("/api/auth/get-session", { token }))).user.id;
    const root = await agent.sendMessage({ threadId: null, authorKind: "user", authorId: owner, body: "my thread" });
    const thread = await agent.createThread(root.id, "Mine");

    const signUp = await api("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: `m${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "M" }),
    });
    const member = signUp.headers.get("set-auth-token")!;
    const memberId = (await json<{ user: { id: string } }>(api("/api/auth/get-session", { token: member }))).user.id;
    await env.DB.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
      .bind(project.id, memberId, Date.now())
      .run();
    const { routine } = await json<{ routine: Routine }>(
      api(`/api/projects/${project.id}/routines`, {
        method: "POST",
        token: member,
        body: JSON.stringify({
          name: "Sneaky",
          prompt: "Use their connectors.",
          target: { kind: "thread", threadId: thread.id },
          schedule: { kind: "once", at: new Date(Date.now() + 3600_000).toISOString() },
        }),
      }),
    );
    const threadAgent = await getAgentByName(env.THREAD_AGENT, thread.id);
    await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Keep notes." });
    const requester = () =>
      runInDurableObject(threadAgent as unknown as DurableObjectStub, (_, state) => {
        const rows = state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'requester'").toArray();
        return rows[0]?.value ?? null;
      });
    expect(await until(async () => (await requester()) === owner, "the thread's first turn")).toBe(true);
    await agent.runRoutineNow(routine.id);
    expect(await until(async () => (await requester()) === memberId, "the routine's turn")).toBe(true);
    await settled(threadAgent);
  }, 20_000);

  it("works a follow-up forwarded from the project chat for whoever asked it, not for the thread's person", async () => {
    const { token, project, ws, agent } = await setup();
    ws.close();
    const owner = (await json<{ user: { id: string } }>(api("/api/auth/get-session", { token }))).user.id;
    const root = await agent.sendMessage({ threadId: null, authorKind: "user", authorId: owner, body: "my thread" });
    const thread = await agent.createThread(root.id, "Mine");
    const signUp = await api("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: `m${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "M" }),
    });
    const memberId = (await json<{ user: { id: string } }>(api("/api/auth/get-session", { token: signUp.headers.get("set-auth-token")! }))).user.id;
    await env.DB.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
      .bind(project.id, memberId, Date.now())
      .run();
    const threadAgent = await getAgentByName(env.THREAD_AGENT, thread.id);
    await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Keep notes." });
    const requester = () =>
      runInDurableObject(threadAgent as unknown as DurableObjectStub, (_, state) => {
        const rows = state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'requester'").toArray();
        return rows[0]?.value ?? null;
      });
    expect(await until(async () => (await requester()) === owner, "the thread's first turn")).toBe(true);

    // The member asked in the project chat; the coordinator forwarded it here.
    await threadAgent.wake({ kind: "coordinator", note: "Add a test.", forwardedFor: memberId });
    expect(await until(async () => (await requester()) === memberId, "the forwarded turn")).toBe(true);
    // Not one known person: nobody's own computer or connectors.
    await threadAgent.wake({ kind: "coordinator", note: "Two people asked.", forwardedFor: null });
    expect(await until(async () => (await requester()) === "", "the unattributed turn")).toBe(true);
    // The coordinator answering the thread's own request is not an ask: the thread's person again.
    await threadAgent.wake({ kind: "coordinator", note: "Permission granted." });
    expect(await until(async () => (await requester()) === owner, "the answered turn")).toBe(true);
    await settled(threadAgent);
  }, 30_000);
});
