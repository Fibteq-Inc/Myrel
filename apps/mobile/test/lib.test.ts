import type { Message } from "@altair/protocol";
import { describe, expect, it } from "vitest";
import { chosenOption, decisionAnswers, parseDecision } from "../src/lib/decision";
import { notificationPath } from "../src/lib/push-target";
import { secureKey } from "../src/lib/secure-key";

describe("secureKey", () => {
  it("keeps allowed characters and escapes the rest without collisions", () => {
    expect(secureKey("altair.token-1")).toBe("altair.token-1");
    const a = secureKey("altair:token:https://a.example.com");
    expect(a).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(secureKey("a_b")).not.toBe(secureKey("a:b"));
    expect(secureKey("https://a.b")).not.toBe(secureKey("https___a.b"));
  });
});

describe("decisions", () => {
  const json = JSON.stringify({
    question: "Redirect old links?",
    options: [
      { label: "Redirect", consequence: "Old links keep working." },
      { label: "Close", consequence: "Old links fail." },
    ],
    recommended: 0,
  });

  it("parses a valid decision block and rejects malformed ones", () => {
    expect(parseDecision(json)?.options[1]?.label).toBe("Close");
    expect(parseDecision("{")).toBeNull();
    expect(parseDecision(JSON.stringify({ question: "Q", options: [{ label: "only one" }] }))).toBeNull();
    expect(parseDecision(JSON.stringify({ question: "Q", options: [{ label: "a" }, { label: "b" }] }))?.options[0]).toEqual({
      label: "a",
      consequence: "",
    });
  });

  it("matches an answer to its option and finds answers in order", () => {
    const d = parseDecision(json)!;
    expect(chosenOption(d, " redirect ")).toBe(0);
    expect(chosenOption(d, "something else")).toBe(-1);
    expect(chosenOption(d, undefined)).toBe(-1);

    const msg = (id: string, authorKind: Message["authorKind"], body: string, seq: number): Message => ({
      id,
      projectId: "proj_01J00000000000000000000000",
      threadId: null,
      authorKind,
      authorId: authorKind === "user" ? "u1" : "agent",
      body,
      seq,
      createdAt: new Date(seq * 1000).toISOString(),
    });
    const answers = decisionAnswers([msg("a1", "agent", "q", 1), msg("u1", "user", "Redirect", 2), msg("a2", "agent", "q2", 3)]);
    expect(answers.get("a1")).toBe("Redirect");
    expect(answers.has("a2")).toBe(false);
  });
});

describe("notificationPath", () => {
  it("opens the thread, else the project, and ignores anything else", () => {
    expect(notificationPath({ projectId: "proj_01ABC", threadId: "thr_01DEF" })).toBe("/projects/proj_01ABC/threads/thr_01DEF");
    expect(notificationPath({ projectId: "proj_01ABC", threadId: null })).toBe("/projects/proj_01ABC");
    expect(notificationPath({ projectId: "../evil" })).toBeNull();
    expect(notificationPath(null)).toBeNull();
  });
});
