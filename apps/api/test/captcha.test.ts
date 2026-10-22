import { env as testEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth";
import { captchaConfig } from "../src/captcha";

// Secrets are injected by vitest.config.ts, so the generated binding types do not list them.
const env = testEnv as unknown as Env;
const withTurnstile = { ...env, TURNSTILE_SITE_KEY: "site-key", TURNSTILE_SECRET_KEY: "secret-key" } as Env;

function signUp(auth: ReturnType<typeof createAuth>, token?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("x-captcha-response", token);
  return auth.handler(
    new Request("http://myrel.test/api/auth/sign-up/email", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: `c${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "C" }),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Turnstile on sign-up", () => {
  it("is off unless both keys are set", () => {
    expect(captchaConfig(env)).toBeNull();
    expect(captchaConfig({ ...env, TURNSTILE_SITE_KEY: "site-key" } as Env)).toBeNull();
    expect(captchaConfig(withTurnstile)).toEqual({ provider: "turnstile", siteKey: "site-key" });
  });

  it("creates an account only with a token Cloudflare accepts", async () => {
    const verified: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("challenges.cloudflare.com")) return realFetch(input, init);
      const { response, secret } = JSON.parse(String(init?.body)) as { response: string; secret: string };
      verified.push(secret);
      return Response.json({ success: response === "good" });
    });
    const auth = createAuth(withTurnstile);
    expect((await signUp(auth)).status).toBe(400);
    expect((await signUp(auth, "bad")).status).toBe(403);
    expect((await signUp(auth, "good")).status).toBe(200);
    expect(verified).toEqual(["secret-key", "secret-key"]);
    // Without the keys nothing is asked.
    expect((await signUp(createAuth(env))).status).toBe(200);
  });
});
