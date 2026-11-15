import { describe, expect, it, vi } from "vitest";
import type { KeyValueStore } from "../src/platform";
import { keychainStore } from "../src/secrets";

/** A store over a map that fails while `failing` is set, counting reads. */
function fakeStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const store = {
    values,
    failing: false,
    reads: 0,
    get(key: string) {
      store.reads++;
      if (store.failing) return Promise.reject(new Error("Platform secure storage failure"));
      return Promise.resolve(values.get(key) ?? null);
    },
    set(key: string, value: string | null) {
      if (store.failing) return Promise.reject(new Error("Platform secure storage failure"));
      if (value === null) values.delete(key);
      else values.set(key, value);
      return Promise.resolve();
    },
  } satisfies KeyValueStore & Record<string, unknown>;
  return store;
}

describe("keychainStore", () => {
  it("reads the keychain once and keeps the token through a keychain failure", async () => {
    const keychain = fakeStore({ token: "a" });
    const onError = vi.fn();
    const secrets = keychainStore(keychain, fakeStore(), onError);

    expect(await secrets.get("token")).toBe("a");
    keychain.failing = true;
    expect(await Promise.all([secrets.get("token"), secrets.get("token")])).toEqual(["a", "a"]);
    expect(keychain.reads).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("asks the keychain once for requests made at the same time", async () => {
    const keychain = fakeStore({ token: "a" });
    const secrets = keychainStore(keychain, fakeStore());
    expect(await Promise.all([secrets.get("token"), secrets.get("token"), secrets.get("token")])).toEqual(["a", "a", "a"]);
    expect(keychain.reads).toBe(1);
  });

  it("keeps a token the keychain refused in app storage, and finds it after a restart", async () => {
    const keychain = fakeStore();
    const fallback = fakeStore();
    const onError = vi.fn();
    keychain.failing = true;
    await keychainStore(keychain, fallback, onError).set("token", "b");
    expect(fallback.values.get("token")).toBe("b");
    expect(onError).toHaveBeenCalledOnce();

    // Next start: the keychain works again but never got the token.
    keychain.failing = false;
    expect(await keychainStore(keychain, fallback).get("token")).toBe("b");
  });

  it("falls back to app storage when the keychain cannot be read", async () => {
    const keychain = fakeStore({ token: "a" });
    keychain.failing = true;
    const onError = vi.fn();
    expect(await keychainStore(keychain, fakeStore({ token: "b" }), onError).get("token")).toBe("b");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("removes the app storage copy once the keychain takes the token again", async () => {
    const keychain = fakeStore();
    const fallback = fakeStore({ token: "old" });
    const secrets = keychainStore(keychain, fallback);
    await secrets.set("token", "new");
    expect(keychain.values.get("token")).toBe("new");
    expect(fallback.values.has("token")).toBe(false);
    expect(await secrets.get("token")).toBe("new");
  });

  it("forgets the token on sign-out everywhere it was kept", async () => {
    const keychain = fakeStore({ token: "a" });
    const fallback = fakeStore({ token: "b" });
    const secrets = keychainStore(keychain, fallback);
    expect(await secrets.get("token")).toBe("a");
    await secrets.set("token", null);
    expect(await secrets.get("token")).toBeNull();
    expect(keychain.values.has("token")).toBe(false);
    expect(fallback.values.has("token")).toBe(false);
  });

  it("tries again after a read that failed everywhere", async () => {
    const keychain = fakeStore({ token: "a" });
    const fallback = fakeStore();
    keychain.failing = true;
    fallback.failing = true;
    const secrets = keychainStore(keychain, fallback);
    await expect(secrets.get("token")).rejects.toThrow();
    keychain.failing = false;
    expect(await secrets.get("token")).toBe("a");
  });
});
