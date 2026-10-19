import { describe, expect, it } from "vitest";
import { storageTokenStore, webPlatform, webStorage } from "../src/platform";

describe("webStorage", () => {
  it("falls back to memory when localStorage is unavailable", () => {
    const store = webStorage();
    store.set("a", "1");
    expect(store.get("a")).toBe("1");
    store.set("a", null);
    expect(store.get("a")).toBeNull();
  });
});

describe("webPlatform", () => {
  it("uses cookies same-origin and a stored bearer token cross-origin", async () => {
    expect(webPlatform({ crossOrigin: false }).tokens).toBeUndefined();
    const tokens = webPlatform({ crossOrigin: true }).tokens!;
    await tokens.set("t1");
    expect(await tokens.get()).toBe("t1");
  });

  it("storageTokenStore round-trips through the given store", async () => {
    const tokens = storageTokenStore(webStorage("test:"), "tok");
    await tokens.set("abc");
    expect(await tokens.get()).toBe("abc");
  });
});
