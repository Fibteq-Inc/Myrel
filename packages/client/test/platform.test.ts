import { describe, expect, it } from "vitest";
import { type Platform, webPlatform, webStorage } from "../src/platform";

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
  it("is a web platform with storage", () => {
    const platform: Platform = webPlatform();
    expect(platform.name).toBe("web");
    expect(platform.storage.get("missing")).toBeNull();
  });
});
