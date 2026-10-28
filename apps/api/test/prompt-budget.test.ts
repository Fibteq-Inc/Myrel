import type { Message, Thread } from "@myrel/protocol";
import { describe, expect, it } from "vitest";
import { unchangedSections } from "../src/agents/harness-agent";
import { threadPrompt, type ThreadPromptSize } from "../src/agents/thread-worker";

const thread = { id: "thr_1", title: "Long thread", resolved: false, statusText: null } as Thread;
const message = (seq: number, body: string): Message => ({
  id: `cmsg_${String(seq).padStart(26, "0")}`,
  projectId: "prj_1",
  threadId: "thr_1",
  authorKind: seq % 2 ? "user" : "agent",
  authorId: "usr_1",
  body,
  seq,
  createdAt: "2026-10-26T10:00:00.000Z",
});

const input = (messages: Message[], extra: Partial<Parameters<typeof threadPrompt>[0]> = {}) => ({
  projectName: "Myrel",
  brief: "THE BRIEF",
  thread,
  root: message(1, "THE FIRST ASK"),
  messages,
  names: { usr_1: "İsmail" },
  lastSeenSeq: 0,
  notes: [],
  knowledge: { instructions: "THE INSTRUCTIONS", memoryIndex: "THE MEMORY", memory: [], files: [], moreFiles: 0 },
  repos: [],
  routineRuns: [],
  routines: [],
  now: new Date("2026-10-26T11:00:00.000Z"),
  defaultTimezone: "UTC",
  ...extra,
});

describe("threadPrompt budget", () => {
  const messages = Array.from({ length: 60 }, (_, i) => message(i + 2, `message ${i + 2} ${"x".repeat(2000)}`));

  it("leaves the thread whole when it fits", () => {
    const prompt = threadPrompt(input(messages, { budget: 1_000_000 }));
    expect(prompt).toBe(threadPrompt(input(messages)));
    expect(prompt).not.toContain("left out");
  });

  it("drops the oldest messages first and keeps instructions, memory, brief and the first ask", () => {
    const prompt = threadPrompt(input(messages, { budget: 40_000 }));
    expect(prompt.length).toBeLessThanOrEqual(40_000);
    for (const kept of ["THE INSTRUCTIONS", "THE MEMORY", "THE BRIEF", "THE FIRST ASK", "message 61 ", "Continue the work now."]) {
      expect(prompt).toContain(kept);
    }
    expect(prompt).not.toContain("message 2 ");
    const left = Number(/The (\d+) oldest messages are left out/.exec(prompt)?.[1]);
    expect(left).toBeGreaterThan(0);
    // No more than needed: one message fewer left out would not fit.
    expect(prompt).toContain(`message ${left + 2} `);
    expect(prompt).not.toContain(`message ${left + 1} `);
  });

  it("then drops old coordinator notes", () => {
    const notes = Array.from({ length: 30 }, (_, i) => ({ body: `note ${i} ${"n".repeat(1000)}`, createdAt: "2026-10-26T10:00:00.000Z", isNew: i === 29 }));
    const prompt = threadPrompt(input(messages.slice(-1), { notes, budget: 15_000 }));
    expect(prompt.length).toBeLessThanOrEqual(15_000);
    expect(prompt).toContain("oldest notes are left out");
    expect(prompt).toContain("note 29 ");
    expect(prompt).not.toContain("note 0 ");
  });

  it("cuts one huge newest message but keeps the start and the end", () => {
    const prompt = threadPrompt(input([message(2, `huge ${"y".repeat(200_000)}`)], { budget: 50_000 }));
    expect(prompt.length).toBeLessThanOrEqual(50_000);
    expect(prompt).toContain("THE BRIEF");
    expect(prompt).toContain("part of this prompt is cut here");
    expect(prompt.endsWith("Continue the work now.")).toBe(true);
  });

  it("passes each lasting section once however much it has to fit", () => {
    const sections = unchangedSections([]);
    threadPrompt(input(messages, { budget: 40_000, lasting: sections.lasting }));
    // Knowledge, brief and repositories.
    expect(sections.hashes).toHaveLength(3);
  });

  it("measures each kind of context and what was left out", () => {
    const notes = [{ body: `note ${"n".repeat(500)}`, createdAt: "2026-10-26T10:00:00.000Z", isNew: true }];
    let size: ThreadPromptSize | undefined;
    const prompt = threadPrompt(input(messages, { notes, budget: 40_000, measure: (s) => (size = s) }));
    const { droppedMessages, droppedNotes, cut, ...parts } = size!;
    expect(Number(/The (\d+) oldest messages are left out/.exec(prompt)?.[1])).toBe(droppedMessages);
    expect(droppedNotes).toBe(0);
    expect(cut).toBe(false);
    expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBe(prompt.length);
    expect(parts.conversation).toBeGreaterThan(30_000);
    expect(parts.notes).toBeGreaterThan(500);
    expect(parts.brief).toBeGreaterThan(0);
    expect(parts.knowledge).toBeGreaterThan(0);

    threadPrompt(input(messages.slice(0, 2), { measure: (s) => (size = s) }));
    expect(size!.droppedMessages).toBe(0);
  });
});
