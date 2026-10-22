import { describe, expect, it } from "vitest";
import { type FileRefContext, resolveFileCode, resolveFileHref, threadIdFromHref, threadLink } from "../src/links";

describe("thread links", () => {
  const id = "thr_01JAAAAAAAAAAAAAAAAAAAAAAA";

  it("round-trips a thread through its Markdown link", () => {
    expect(threadLink({ id, title: "Hesap [makinesi]" })).toBe(`[Hesap makinesi](#${id})`);
    expect(threadIdFromHref(`#${id}`)).toBe(id);
  });

  it("ignores other links", () => {
    for (const href of [undefined, "https://example.com", `#${id}x`, "#cmsg_01JAAAAAAAAAAAAAAAAAAAAAAA"]) {
      expect(threadIdFromHref(href)).toBeNull();
    }
  });
});

describe("file references", () => {
  const projectFiles = new Set(["guvenlik-taramasi/rapor.md", "DURUM.md"]);
  const mine: FileRefContext = { projectFiles, workspace: "mine" };
  const other: FileRefContext = { projectFiles, workspace: "other" };
  const cloud: FileRefContext = { projectFiles, workspace: null };

  it("opens project files from inline code, for everyone", () => {
    for (const ctx of [mine, other, cloud]) {
      expect(resolveFileCode("guvenlik-taramasi/rapor.md", ctx)).toEqual({ kind: "project", path: "guvenlik-taramasi/rapor.md" });
      expect(resolveFileCode("DURUM.md", ctx)).toEqual({ kind: "project", path: "DURUM.md" });
      expect(resolveFileCode("./guvenlik-taramasi/rapor.md:12", ctx)).toEqual({ kind: "project", path: "guvenlik-taramasi/rapor.md" });
    }
  });

  it("opens paths on the viewer's computer, and marks someone else's", () => {
    expect(resolveFileCode("metser/sonuc.json", mine)).toEqual({ kind: "local", path: "metser/sonuc.json" });
    expect(resolveFileCode("/Users/a/notes.md#L3", mine)).toEqual({ kind: "local", path: "/Users/a/notes.md" });
    expect(resolveFileCode("apps/web/src/x.tsx:4:2", other)).toEqual({ kind: "elsewhere", path: "apps/web/src/x.tsx" });
    expect(resolveFileCode("metser/sonuc.json", cloud)).toBeNull();
  });

  it("leaves ordinary code alone", () => {
    for (const code of ["npm test", "foo()", "package.json", "v1.2", "1/2.5", "a = b.c", "github.com/x/y.git", "https://x.io/a.md", "src/", ".env", "x.map(f)"]) {
      expect(resolveFileCode(code, mine), code).toBeNull();
    }
  });

  it("resolves local links, and keeps web links as they are", () => {
    expect(resolveFileHref("guvenlik-taramasi/rapor.md", other)).toEqual({ kind: "project", path: "guvenlik-taramasi/rapor.md" });
    expect(resolveFileHref("file:///Users/a/My%20Notes.md", mine)).toEqual({ kind: "local", path: "/Users/a/My Notes.md" });
    expect(resolveFileHref("NOTES", mine)).toEqual({ kind: "local", path: "NOTES" });
    expect(resolveFileHref("NOTES", cloud)).toBeNull();
    for (const href of [undefined, "https://example.com/a.md", "#thr_01JAAAAAAAAAAAAAAAAAAAAAAA", "mailto:a@b.co", "/projects/x"]) {
      expect(resolveFileHref(href, mine)).toBeNull();
    }
  });
});
