import { API_VERSION } from "@myrel/protocol";
import { describe, expect, it } from "vitest";
import { webPlatform, webStorage } from "../src/platform";
import { currentServer, normalizeServerUrl, probeServer, saveServer, tokenStoreFor } from "../src/server";

const info = { app: "myrel", apiVersion: API_VERSION, name: "Acme", auth: { emailPassword: true, signUp: false }, billing: false, legal: null };
const respond = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe("normalizeServerUrl", () => {
  it("adds https and strips paths", () => {
    expect(normalizeServerUrl(" myrel.acme.com/ ")).toBe("https://myrel.acme.com");
    expect(normalizeServerUrl("http://localhost:8787/api")).toBe("http://localhost:8787");
  });

  it("rejects empty and non-http addresses", () => {
    expect(() => normalizeServerUrl("")).toThrow();
    expect(() => normalizeServerUrl("ftp://x.com")).toThrow();
  });
});

describe("probeServer", () => {
  it("returns info for a compatible Myrel server", async () => {
    expect(await probeServer("https://a.test", respond(info))).toEqual(info);
  });

  it("rejects other apps, unreachable servers and other API versions", async () => {
    await expect(probeServer("https://a.test", respond({ hello: 1 }))).rejects.toThrow(/not a Myrel server/);
    await expect(probeServer("https://a.test", respond(info, 404))).rejects.toThrow(/not a Myrel server/);
    await expect(probeServer("https://a.test", (async () => Promise.reject(new TypeError())) as typeof fetch)).rejects.toThrow(
      /reach/,
    );
    await expect(probeServer("https://a.test", respond({ ...info, apiVersion: API_VERSION + 1 }))).rejects.toThrow(
      /Update the app/,
    );
  });
});

describe("server choice", () => {
  it("remembers the chosen server", async () => {
    const storage = webStorage("t1:");
    expect(await currentServer(storage, "https://default.test")).toBe("https://default.test");
    await saveServer(storage, "https://acme.test");
    expect(await currentServer(storage)).toBe("https://acme.test");
  });

  it("keeps tokens per server and uses cookies for same-origin web", async () => {
    const platform = webPlatform();
    expect(tokenStoreFor(platform, "")).toBeUndefined();
    const a = tokenStoreFor(platform, "https://a.test")!;
    const b = tokenStoreFor(platform, "https://b.test")!;
    await a.set("token-a");
    expect(await a.get()).toBe("token-a");
    expect(await b.get()).toBeNull();
  });
});
