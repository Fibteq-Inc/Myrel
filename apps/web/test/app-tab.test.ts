import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A tab's sessionStorage, as far as app-tab.ts uses it. */
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  };
}

/** app-tab.ts with a fresh module state, loaded at `search`. */
async function load(search: string) {
  vi.stubGlobal("location", { search });
  vi.resetModules();
  return import("../src/lib/app-tab");
}

describe("app tab", () => {
  beforeEach(() => vi.stubGlobal("sessionStorage", memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it("is not one without ?app", async () => {
    const tab = await load("?tab=github");
    tab.markAppTab();
    expect(tab.openedFromApp()).toBe(false);
  });

  it("is one when a page opened with ?app, also as the last parameter", async () => {
    for (const search of ["?app", "?tab=github&app", "?connector=ok&app="]) {
      vi.stubGlobal("sessionStorage", memoryStorage());
      const tab = await load(search);
      tab.markAppTab();
      expect(tab.openedFromApp()).toBe(true);
    }
  });

  it("stays one on later pages of the tab, after the address lost ?app", async () => {
    (await load("?app")).markAppTab();
    // Signing in, or GitHub's round trip, loads the app again without it.
    const later = await load("");
    later.markAppTab();
    expect(later.openedFromApp()).toBe(true);
  });

  it("counts for the page load when the browser keeps no sessionStorage", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const tab = await load("?app");
    expect(tab.openedFromApp()).toBe(false);
    tab.markAppTab();
    expect(tab.openedFromApp()).toBe(true);
  });
});
