import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/api";
import { memoryTokenStore } from "../src/token-store";

describe("ApiClient", () => {
  it("sends extra headers, the bearer token and the chosen credentials mode", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = new ApiClient({
      baseUrl: "https://altair.example.com/",
      tokens: memoryTokenStore("tok"),
      headers: { origin: "altair://" },
      credentials: "omit",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    await api.registerPushDevice({ token: "ExponentPushToken[x]", platform: "ios" });
    const [call] = calls;
    expect(call?.url).toBe("https://altair.example.com/api/push/devices");
    expect(call?.init.credentials).toBe("omit");
    expect(call?.init.headers).toMatchObject({ origin: "altair://", authorization: "Bearer tok" });
    expect(JSON.parse(String(call?.init.body))).toEqual({ token: "ExponentPushToken[x]", platform: "ios" });
  });
});
