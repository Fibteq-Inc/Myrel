import { describe, expect, it } from "vitest";
import { threadIdFromHref, threadLink } from "../src/links";

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
