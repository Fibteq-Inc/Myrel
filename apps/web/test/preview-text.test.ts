import { describe, expect, it } from "vitest";
import { nextPreviewText, previewTextFor } from "../src/lib/preview-text";

describe("preview text", () => {
  it("keeps the same object when a refetch reads the same text", () => {
    const first = nextPreviewText(null, "notes/a.md", "# A");
    expect(nextPreviewText(first, "notes/a.md", "# A")).toBe(first);
  });

  it("takes changed text or another file", () => {
    const first = nextPreviewText(null, "notes/a.md", "# A");
    expect(nextPreviewText(first, "notes/a.md", "# A2")).toEqual({ path: "notes/a.md", text: "# A2" });
    expect(nextPreviewText(first, "notes/b.md", "# A")).toEqual({ path: "notes/b.md", text: "# A" });
  });

  it("shows no text for a file that is not loaded yet", () => {
    const loaded = nextPreviewText(null, "notes/a.md", "# A");
    expect(previewTextFor(loaded, "notes/a.md")).toBe("# A");
    expect(previewTextFor(loaded, "notes/b.md")).toBeNull();
    expect(previewTextFor(null, "notes/a.md")).toBeNull();
  });
});
