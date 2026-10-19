import { createId, type Message, type Task, type Thread } from "@altair/protocol";
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  applyMessage,
  applyTasks,
  emptyProjectState,
  parseChecklist,
  projectChat,
  threadByRoot,
  threadMessages,
  threadTasks,
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
  title: "T",
  status: "working",
  statusText: null,
  resolved: false,
  label: null,
  createdAt: now,
  updatedAt: now,
  ...patch,
});

describe("project state", () => {
  it("splits project chat from threads and tracks thread updates, reactions and activity", () => {
    const root = msg(1);
    const t = thread(root.id);
    let s = applyMessage(emptyProjectState, root);
    s = applyEvent(s, { type: "sync.result", messages: [], hasMore: false, threads: [t], reactions: [] });
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

  it("parses a status checklist", () => {
    expect(parseChecklist("Research\n\n✓ Read docs\n**✓ Compared options**\n✱ Writing summary\n○ Reply")).toEqual({
      title: "Research",
      items: [
        { state: "done", text: "Read docs" },
        { state: "done", text: "Compared options" },
        { state: "active", text: "Writing summary" },
        { state: "todo", text: "Reply" },
      ],
    });
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
