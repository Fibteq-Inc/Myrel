import { createId, formatPlan, type Message, planChecklist, type Task, type Thread } from "@myrel/protocol";
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  applyMessage,
  applyMessages,
  applyTasks,
  artifactList,
  checklistProgress,
  emptyProjectState,
  parseChecklist,
  projectChat,
  threadByCard,
  threadByRoot,
  threadMessages,
  threadReplyCount,
  threadTasks,
  threadUsage,
} from "../src/project-state";

const projectId = createId("project");
const now = new Date().toISOString();
const msg = (seq: number, threadId: string | null = null): Message => ({
  id: createId("message"),
  projectId,
  threadId,
  authorKind: "user",
  authorId: "u1",
  body: `m${seq}`,
  seq,
  createdAt: now,
});
const thread = (rootMessageId: string, patch: Partial<Thread> = {}): Thread => ({
  id: createId("thread"),
  projectId,
  rootMessageId,
  ackMessageId: null,
  title: "T",
  status: "working",
  statusText: null,
  resolved: false,
  closeReason: null,
  duplicateOf: null,
  label: null,
  createdAt: now,
  updatedAt: now,
  ...patch,
});

describe("project state", () => {
  it("puts a thread card under the coordinator's acknowledgement when there is one", () => {
    const ask = msg(1);
    const ack = msg(2);
    const withAck = thread(ask.id, { ackMessageId: ack.id });
    const older = thread(msg(3).id);
    const s = { ...emptyProjectState, threads: { [withAck.id]: withAck, [older.id]: older } };
    expect(threadByCard(s).get(ack.id)?.id).toBe(withAck.id);
    expect(threadByCard(s).has(ask.id)).toBe(false);
    expect(threadByCard(s).get(older.rootMessageId)?.id).toBe(older.id);
  });

  it("keeps artifacts from sync and live updates, newest first", () => {
    const art = (title: string, updatedAt: string, version = 1) => ({
      id: createId("artifact"),
      projectId,
      threadId: null,
      title,
      description: null,
      version,
      createdAt: updatedAt,
      updatedAt,
    });
    const old = art("Old", "2026-01-01T00:00:00.000Z");
    const recent = art("Recent", "2026-02-01T00:00:00.000Z");
    let s = applyEvent(emptyProjectState, {
      type: "sync.result",
      messages: [],
      hasMore: false,
      threads: [],
      reactions: [],
      artifacts: [old, recent],
      routines: [],
    });
    expect(artifactList(s).map((a) => a.title)).toEqual(["Recent", "Old"]);
    s = applyEvent(s, { type: "artifact.updated", artifact: { ...old, version: 2, updatedAt: "2026-03-01T00:00:00.000Z" } });
    expect(artifactList(s).map((a) => [a.title, a.version])).toEqual([
      ["Old", 2],
      ["Recent", 1],
    ]);
  });

  it("splits project chat from threads and tracks thread updates, reactions and activity", () => {
    const root = msg(1);
    const t = thread(root.id);
    let s = applyMessage(emptyProjectState, root);
    s = applyEvent(s, { type: "sync.result", messages: [], hasMore: false, threads: [t], reactions: [], artifacts: [], routines: [] });
    s = applyMessage(s, msg(2, t.id));
    s = applyEvent(s, { type: "thread.updated", thread: { ...t, status: "review_ready" } });
    const reaction = { messageId: root.id, emoji: "👍", authorKind: "agent" as const, authorId: "coordinator" };
    s = applyEvent(s, { type: "reaction.added", reaction });
    s = applyEvent(s, { type: "reaction.added", reaction });
    s = applyEvent(s, { type: "agent.activity", threadId: t.id, active: true });
    s = applyEvent(s, { type: "agent.activity", threadId: null, active: true });
    s = applyEvent(s, { type: "agent.activity", threadId: null, active: false });

    expect(projectChat(s).map((m) => m.seq)).toEqual([1]);
    expect(threadMessages(s, t.id).map((m) => m.seq)).toEqual([2]);
    expect(threadByRoot(s).get(root.id)?.status).toBe("review_ready");
    expect(s.reactions[root.id]).toHaveLength(1);
    expect(s.active).toEqual({ [t.id]: true });
  });

  it("adds a sync page at once and keeps each conversation's list until the messages change", () => {
    const root = msg(1);
    const t = thread(root.id);
    const s = applyMessages(emptyProjectState, [root, msg(2, t.id), msg(3, t.id)]);
    expect(applyMessages(s, [])).toBe(s);
    expect(threadMessages(s, t.id).map((m) => m.seq)).toEqual([2, 3]);
    expect(threadMessages(s, t.id)).toBe(threadMessages(s, t.id));
    expect(projectChat(s)).toBe(projectChat(s));
    const next = applyMessage(s, msg(4, t.id));
    expect(threadMessages(next, t.id).map((m) => m.seq)).toEqual([2, 3, 4]);
    expect(threadReplyCount(next, t.id)).toBe(3);
    expect(threadMessages(s, "thr_none")).toEqual([]);
  });

  it("drops stale activity on a resync; the server sends the live ones again", () => {
    let s = applyEvent(emptyProjectState, { type: "agent.activity", threadId: "t1", active: true, label: "Running tests" });
    s = applyEvent(s, { type: "sync.result", messages: [], hasMore: false, threads: [], reactions: [], artifacts: [], routines: [] });
    expect(s.active).toEqual({});
    expect(s.progress).toEqual({});
  });

  it("parses a status checklist", () => {
    expect(parseChecklist("Research\n\n✓ Read docs\n**✓ Compared options**\n✱ Writing summary\n○ Reply")).toEqual({
      title: "Research",
      items: [
        { state: "done", text: "Read docs", depth: 0 },
        { state: "done", text: "Compared options", depth: 0 },
        { state: "active", text: "Writing summary", depth: 0 },
        { state: "todo", text: "Reply", depth: 0 },
      ],
    });
  });

  it("updates a plan card in place and leaves it out of the reply count", () => {
    const t = createId("thread");
    const card = { ...msg(2, t), authorKind: "agent" as const, body: formatPlan("Plan\n\n✱ a\n○ b") };
    let s = applyMessage(applyMessage(emptyProjectState, msg(1, t)), card);
    s = applyEvent(s, { type: "message.updated", message: { ...card, body: formatPlan("Plan\n\n✓ a\n✱ b") } });
    expect(threadMessages(s, t).map((m) => planChecklist(m.body))).toEqual([null, "Plan\n\n✓ a\n✱ b"]);
    expect(threadReplyCount(s, t)).toBe(1);
  });

  it("parses skipped steps and a task's steps nested under the plan", () => {
    const { items } = parseChecklist("Fix\n\n✓ Read code\n✱ Fix bug\n  ✓ Sandbox ready\n  ✱ Agent working\n    ✓ edit a.ts\n– Deploy\n○ Reply");
    expect(items.map((i) => [i.state, i.depth])).toEqual([
      ["done", 0],
      ["active", 0],
      ["done", 1],
      ["active", 1],
      ["done", 2],
      ["skipped", 0],
      ["todo", 0],
    ]);
    // Only the plan's own steps count, and a skipped step is not work left.
    expect(checklistProgress(items)).toEqual({ done: 1, total: 3 });
  });
});

describe("thread usage", () => {
  it("sums the stats under a thread's messages, leaving the person's own CLI unpriced but not unknown", () => {
    const root = msg(1);
    const th = thread(root.id);
    const base = { calls: 0, cachedInputTokens: 0, model: "m" };
    const cloud = { ...msg(2, th.id), stats: { ...base, durationMs: 1000, inputTokens: 100, outputTokens: 10, costMicros: 500, runtime: "cloud" as const, harness: "opencode" } };
    const local = { ...msg(3, th.id), stats: { ...base, durationMs: 2000, inputTokens: 50, outputTokens: 5, costMicros: null, runtime: "local" as const, harness: "claude" } };
    let s = emptyProjectState;
    for (const m of [root, cloud, local]) s = applyMessage(s, m);
    expect(threadUsage(s, th.id)).toEqual({ tokens: 165, durationMs: 3000, costMicros: 500 });
    expect(threadUsage(s, createId("thread"))).toBeNull();
  });
});

describe("tasks", () => {
  it("merges fetched task logs with live output and tracks status", () => {
    const threadId = createId("thread");
    const task: Task = {
      id: createId("task"),
      threadId,
      title: "Run tests",
      harness: "shell",
      backend: "sandbox",
      status: "running",
      prUrl: null,
      summary: null,
      createdAt: now,
      finishedAt: null,
    };
    let s = applyEvent(emptyProjectState, { type: "task.updated", task });
    s = applyEvent(s, { type: "task.output", taskId: task.id, threadId, lines: [{ stream: "stdout", text: "live" }] });
    s = applyTasks(s, [{ ...task, log: [{ stream: "system", text: "earlier" }] }]);
    expect(s.output[task.id]!.map((l) => l.text)).toEqual(["earlier", "live"]);
    s = applyEvent(s, { type: "task.updated", task: { ...task, status: "done", prUrl: "https://github.com/a/b/pull/1" } });
    expect(threadTasks(s, threadId).map((t) => [t.status, t.prUrl])).toEqual([["done", "https://github.com/a/b/pull/1"]]);
    expect(parseChecklist("T\n\n✓ a\n✗ b failed").items.map((i) => i.state)).toEqual(["done", "failed"]);
  });
});
