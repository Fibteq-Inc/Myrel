import { describe, expect, it } from "vitest";
import { ClientEvent, createId, Message, Project, ServerEvent } from "../src";

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
    const p = { id: createId("project"), name: "Altair", createdAt: new Date().toISOString() };
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
  it("accepts an Altair server and rejects other apps", async () => {
    const { API_VERSION, ServerInfo } = await import("../src/server");
    const info = { app: "altair", apiVersion: API_VERSION, name: "Altair", auth: { emailPassword: true } };
    // Servers that predate the sign-up switch always allowed sign-up.
    expect(ServerInfo.parse(info)).toEqual({ ...info, auth: { emailPassword: true, signUp: true } });
    expect(ServerInfo.safeParse({ ...info, app: "other" }).success).toBe(false);
  });
});
