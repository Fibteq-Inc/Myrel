import { describe, expect, it } from "vitest";
import { createDraftStore, draftKey } from "../src/drafts";
import type { KeyValueStore } from "../src/platform";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const store: KeyValueStore = {
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      if (value === null) data.delete(key);
      else data.set(key, value);
    },
  };
  return { data, store };
}

describe("draftKey", () => {
  it("keeps the project chat and each thread apart", () => {
    expect(draftKey("p1")).toBe("p1");
    expect(draftKey("p1", null)).toBe("p1");
    expect(draftKey("p1", "t1")).toBe("p1/t1");
  });
});

describe("createDraftStore", () => {
  it("gives a saved draft back after a restart", () => {
    const { store } = memory();
    createDraftStore(store).set("p1", "half a message");
    expect(createDraftStore(store).get("p1")).toBe("half a message");
    expect(createDraftStore(store).get("p2")).toBe("");
  });

  it("drops a draft when its text is emptied", () => {
    const { data, store } = memory();
    const drafts = createDraftStore(store);
    drafts.set("p1", "hello");
    drafts.set("p1", "   ");
    expect(drafts.get("p1")).toBe("");
    expect(data.has("drafts")).toBe(false);
  });

  it("forgets every draft on clear", () => {
    const { data, store } = memory();
    const drafts = createDraftStore(store);
    drafts.set("p1", "a");
    drafts.set("p1/t1", "b");
    drafts.clear();
    expect(drafts.get("p1")).toBe("");
    expect(data.has("drafts")).toBe(false);
  });

  it("drops drafts older than 30 days and ignores broken data", () => {
    const day = 24 * 60 * 60 * 1000;
    const old = JSON.stringify({ p1: { text: "old", at: 0 }, p2: { text: "new", at: 40 * day } });
    expect(createDraftStore(memory({ drafts: old }).store, () => 41 * day).get("p1")).toBe("");
    expect(createDraftStore(memory({ drafts: old }).store, () => 41 * day).get("p2")).toBe("new");
    expect(createDraftStore(memory({ drafts: "{nope" }).store).get("p1")).toBe("");
  });

  it("reads an asynchronous store before saving", async () => {
    const { data, store } = memory({ drafts: JSON.stringify({ p1: { text: "kept", at: Date.now() } }) });
    const slow: KeyValueStore = { get: async (k) => store.get(k), set: async (k, v) => store.set(k, v) };
    const drafts = createDraftStore(slow);
    expect(drafts.get("p1")).toBe("");
    drafts.set("p2", "new");
    await drafts.ready;
    await Promise.resolve();
    expect(drafts.get("p1")).toBe("kept");
    expect(drafts.get("p2")).toBe("new");
    expect(Object.keys(JSON.parse(data.get("drafts")!))).toEqual(expect.arrayContaining(["p1", "p2"]));
  });
});
