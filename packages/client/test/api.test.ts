import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/api";
import { memoryTokenStore } from "../src/token-store";

describe("ApiClient", () => {
  it("sends extra headers, the bearer token and the chosen credentials mode", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = new ApiClient({
      baseUrl: "https://myrel.example.com/",
      tokens: memoryTokenStore("tok"),
      headers: { origin: "myrel://" },
      credentials: "omit",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    await api.request("/api/notifications/subscriptions", { method: "POST", body: { kind: "expo", token: "t" } });
    const [call] = calls;
    expect(call?.url).toBe("https://myrel.example.com/api/notifications/subscriptions");
    expect(call?.init.credentials).toBe("omit");
    expect(call?.init.headers).toMatchObject({ origin: "myrel://", authorization: "Bearer tok" });
    expect(JSON.parse(String(call?.init.body))).toEqual({ kind: "expo", token: "t" });
  });
});
