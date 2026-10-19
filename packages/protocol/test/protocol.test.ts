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
      body: "hi",
    });
  });

  it("rejects empty messages and negative sync cursors", () => {
    expect(ClientEvent.safeParse({ type: "message.send", body: "   " }).success).toBe(false);
    expect(ClientEvent.safeParse({ type: "sync", afterSeq: -1 }).success).toBe(false);
    expect(ClientEvent.safeParse({ type: "nope" }).success).toBe(false);
  });
});

describe("ServerEvent", () => {
  it("parses message.created and sync.result", () => {
    expect(ServerEvent.parse({ type: "message.created", message }).type).toBe("message.created");
    expect(ServerEvent.parse({ type: "sync.result", messages: [message], hasMore: false }).type).toBe("sync.result");
  });
});

describe("ServerInfo", () => {
  it("accepts an Altair server and rejects other apps", async () => {
    const { API_VERSION, ServerInfo } = await import("../src/server");
    const info = { app: "altair", apiVersion: API_VERSION, name: "Altair", auth: { emailPassword: true } };
    expect(ServerInfo.parse(info)).toEqual(info);
    expect(ServerInfo.safeParse({ ...info, app: "other" }).success).toBe(false);
  });
});
