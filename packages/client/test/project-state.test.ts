import { createId, type Message, type Thread } from "@altair/protocol";
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  applyMessage,
  artifactList,
  emptyProjectState,
  parseChecklist,
  projectChat,
  threadByRoot,
  threadMessages,
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
    s = applyEvent(s, { type: "sync.result", messages: [], hasMore: false, threads: [t], reactions: [], artifacts: [] });
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
