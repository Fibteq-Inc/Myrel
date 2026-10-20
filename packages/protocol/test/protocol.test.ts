import { describe, expect, it } from "vitest";
import {
  ClientEvent,
  CreateRoutineInput,
  CronExpression,
  createId,
  formatDecision,
  Message,
  nextCronRun,
  parseCron,
  parseDecision,
  Project,
  ServerEvent,
} from "../src";

const message = {
  id: createId("message"),
  projectId: createId("project"),
  threadId: null,
  authorKind: "user",
  authorId: "user_1",
  body: "hello",
  seq: 1,
  createdAt: new Date().toISOString(),
} as const;

describe("ids", () => {
  it("prefixes ULIDs by kind", () => {
    expect(createId("message")).toMatch(/^cmsg_[0-9A-Z]{26}$/);
    expect(createId("project")).toMatch(/^proj_/);
  });
});

describe("Message", () => {
  it("accepts a valid message", () => {
    expect(Message.parse(message)).toEqual(message);
  });

  it("rejects wrong id prefix, bad author kind and non-positive seq", () => {
    expect(Message.safeParse({ ...message, id: createId("thread") }).success).toBe(false);
    expect(Message.safeParse({ ...message, authorKind: "bot" }).success).toBe(false);
    expect(Message.safeParse({ ...message, seq: 0 }).success).toBe(false);
  });
});

describe("Project", () => {
  it("requires a role", () => {
    const p = { id: createId("project"), name: "Myrel", createdAt: new Date().toISOString() };
    expect(Project.safeParse(p).success).toBe(false);
    expect(Project.safeParse({ ...p, role: "owner" }).success).toBe(true);
  });
});

describe("ClientEvent", () => {
  it("defaults threadId to null and trims body", () => {
    expect(ClientEvent.parse({ type: "message.send", body: "  hi " })).toEqual({
      type: "message.send",
      threadId: null,
      attachments: [],
      body: "hi",
    });
  });

  it("rejects empty messages and negative sync cursors", () => {
    expect(ClientEvent.safeParse({ type: "message.send", body: "   " }).success).toBe(false);
    expect(ClientEvent.safeParse({ type: "sync", afterSeq: -1 }).success).toBe(false);
    expect(ClientEvent.safeParse({ type: "nope" }).success).toBe(false);
  });

  it("accepts a message that only carries attachments, with safe paths", () => {
    const ok = { type: "message.send", body: "", attachments: ["uploads/abc-report.pdf"] };
    expect(ClientEvent.safeParse(ok).success).toBe(true);
    expect(ClientEvent.safeParse({ ...ok, attachments: ["../secret"] }).success).toBe(false);
    expect(ClientEvent.safeParse({ ...ok, attachments: ["/abs/path"] }).success).toBe(false);
  });
});

describe("ServerEvent", () => {
  it("parses message.created and sync.result", () => {
    expect(ServerEvent.parse({ type: "message.created", message }).type).toBe("message.created");
    const sync = ServerEvent.parse({ type: "sync.result", messages: [message], hasMore: false });
    // Older servers send no threads or reactions.
    expect(sync).toMatchObject({ type: "sync.result", threads: [], reactions: [] });
  });

  it("parses thread updates and agent activity", () => {
    const now = new Date().toISOString();
    const thread = {
      id: createId("thread"),
      projectId: message.projectId,
      rootMessageId: message.id,
      title: "Research",
      status: "working",
      statusText: null,
      resolved: false,
      label: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(ServerEvent.parse({ type: "thread.updated", thread }).type).toBe("thread.updated");
    expect(ServerEvent.safeParse({ type: "thread.updated", thread: { ...thread, status: "sleeping" } }).success).toBe(false);
    expect(ServerEvent.parse({ type: "agent.activity", threadId: null, active: true }).type).toBe("agent.activity");
  });
});

describe("ServerInfo", () => {
  it("accepts a Myrel server and rejects other apps", async () => {
    const { API_VERSION, ServerInfo } = await import("../src/server");
    const info = { app: "myrel", apiVersion: API_VERSION, name: "Myrel", auth: { emailPassword: true } };
    // Servers that predate the sign-up switch always allowed sign-up.
    expect(ServerInfo.parse(info)).toEqual({ ...info, auth: { emailPassword: true, signUp: true } });
    expect(ServerInfo.safeParse({ ...info, app: "other" }).success).toBe(false);
  });
});

describe("decision blocks", () => {
  it("round-trips through a fenced block", () => {
    const block = formatDecision({
      question: "Which currency?",
      options: [{ label: "TRY", consequence: "Local buyers" }, { label: "USD" }],
      recommended: 0,
    });
    expect(block.startsWith("```decision\n")).toBe(true);
    const json = block.slice("```decision\n".length, -"\n```".length);
    expect(parseDecision(json)).toEqual({
      question: "Which currency?",
      options: [
        { label: "TRY", consequence: "Local buyers" },
        { label: "USD", consequence: "" },
      ],
      recommended: 0,
    });
  });

  it("rejects malformed blocks", () => {
    expect(parseDecision("not json")).toBeNull();
    expect(parseDecision(JSON.stringify({ question: "Q", options: [{ label: "only one" }] }))).toBeNull();
  });
});

describe("cron", () => {
  const at = (iso: string) => new Date(iso);

  it("finds the next weekday morning in a time zone", () => {
    // Friday 2026-10-16 10:00 in Istanbul (UTC+3) → Monday 09:00 local = 06:00 UTC.
    expect(nextCronRun("0 9 * * 1-5", "Europe/Istanbul", at("2026-10-16T07:00:00Z"))?.toISOString()).toBe(
      "2026-10-19T06:00:00.000Z",
    );
  });

  it("handles steps, lists and either-day matching", () => {
    expect(nextCronRun("*/15 * * * *", "UTC", at("2026-10-19T12:07:30Z"))?.toISOString()).toBe(
      "2026-10-19T12:15:00.000Z",
    );
    expect(nextCronRun("30 8 1,15 * *", "UTC", at("2026-10-19T00:00:00Z"))?.toISOString()).toBe(
      "2026-11-01T08:30:00.000Z",
    );
    // Day 1 of the month OR a Sunday: Sunday 2026-10-25 comes first.
    expect(nextCronRun("0 0 1 * 0", "UTC", at("2026-10-19T00:00:00Z"))?.toISOString()).toBe(
      "2026-10-25T00:00:00.000Z",
    );
    expect(nextCronRun("0 0 29 2 *", "UTC", at("2026-10-19T00:00:00Z"))?.toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("follows daylight saving time", () => {
    // New York leaves DST on 2026-11-01: 09:00 local is 13:00 UTC before, 14:00 UTC after.
    expect(nextCronRun("0 9 * * *", "America/New_York", at("2026-10-31T14:00:00Z"))?.toISOString()).toBe(
      "2026-11-01T14:00:00.000Z",
    );
  });

  it("rejects invalid expressions", () => {
    expect(() => parseCron("61 * * * *")).toThrow();
    expect(() => parseCron("* * *")).toThrow();
    expect(CronExpression.safeParse("0 9 * * 1-5").success).toBe(true);
    expect(CronExpression.safeParse("every day").success).toBe(false);
  });
});

describe("Routine inputs", () => {
  it("defaults the target to the coordinator and the time zone to UTC", () => {
    const input = CreateRoutineInput.parse({ name: "Digest", prompt: "Summarize", schedule: { kind: "cron", cron: "0 9 * * *" } });
    expect(input.target).toEqual({ kind: "coordinator" });
    expect(input.schedule).toEqual({ kind: "cron", cron: "0 9 * * *", timezone: "UTC" });
    expect(CreateRoutineInput.safeParse({ ...input, schedule: { kind: "cron", cron: "0 9 * * *", timezone: "Mars/Base" } }).success).toBe(false);
  });
});
