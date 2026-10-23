import type { Message } from "@myrel/protocol";
import { describe, expect, it } from "vitest";
import { chosenOption, decisionAnswers, parseDecision } from "../src/lib/decision";
import { dataUrlBase64, displayName, fileKind } from "../src/lib/files";
import { surelyLong } from "../src/lib/fold";
import { notificationPath } from "../src/lib/push-target";
import { unwrapHref, wrapHref } from "../src/lib/raw-href";
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

describe("raw hrefs", () => {
  it("survive react-native-marked's rewrite of links without a scheme", () => {
    for (const href of ["#thr_01M5KPJTCFFJ9NBF9VG26M2Y6F", "notes/rapor.md", "/abs/x.ts", "https://x.io"]) {
      expect(wrapHref(href)).toMatch(/^[a-z]+:/i);
      expect(unwrapHref(wrapHref(href))).toBe(href);
    }
    expect(unwrapHref("https://x.io")).toBe("https://x.io");
  });
});

describe("surelyLong", () => {
  it("folds up front only text far past the limit", () => {
    expect(surelyLong("short note", 10)).toBe(false);
    expect(surelyLong("line\n".repeat(15), 10)).toBe(false);
    expect(surelyLong("line\n".repeat(25), 10)).toBe(true);
    expect(surelyLong("a".repeat(45 * 21), 10)).toBe(true);
  });
});

describe("files", () => {
  it("drops the upload stamp from names", () => {
    expect(displayName("uploads/mvkokmoc16c9-image.png")).toBe("image.png");
    expect(displayName("reports/mvk-summary.md")).toBe("mvk-summary.md");
  });

  it("goes by content type, falling back to the extension", () => {
    expect(fileKind("image/png", "uploads/x-photo.png")).toBe("image");
    expect(fileKind("", "uploads/x-photo.JPEG")).toBe("image");
    expect(fileKind("application/octet-stream", "notes.md")).toBe("markdown");
    expect(fileKind("text/plain", "docs/README.MARKDOWN")).toBe("markdown");
    expect(fileKind("text/markdown", "notes")).toBe("markdown");
    expect(fileKind("text/plain", "notes.txt")).toBe("text");
    expect(fileKind("", "src/app.tsx")).toBe("text");
    expect(fileKind("application/json", "data")).toBe("text");
    expect(fileKind("application/pdf", "report.pdf")).toBe("other");
  });

  it("takes the payload of a data URL", () => {
    expect(dataUrlBase64("data:image/png;base64,iVBORw0K")).toBe("iVBORw0K");
    expect(dataUrlBase64("nonsense")).toBe("");
  });
});
