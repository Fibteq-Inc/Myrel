import type { NotificationConfig, NotificationSettings, Project } from "@altair/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { b64urlDecode, b64urlEncode } from "../src/notifications/webpush";
import { emails, outbound, pushStatus, resetFakeModel } from "./fake-llm";

const BASE = "http://altair.test";

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function setup() {
  const signUp = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({
      email: `u${crypto.randomUUID()}@example.com`,
      password: "correct-horse-battery",
      name: "T",
    }),
  });
  const token = signUp.headers.get("set-auth-token")!;
  const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Myrel" }) });
  const { project } = (await res.json()) as { project: Project };
  const agent = await getAgentByName(env.PROJECT_AGENT, project.id);
  const root = await agent.sendMessage({ threadId: null, authorKind: "user", authorId: "x", body: "do it" });
  const thread = await agent.createThread(root.id, "Release notes");
  return { token, project, agent, thread };
}

/** A browser's side of Web Push: its key pair and auth secret, and how it decrypts a message. */
async function fakeBrowser() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const p256dh = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) => {
    const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
  };
  const enc = (s: string) => new TextEncoder().encode(s);
  return {
    keys: { p256dh: b64urlEncode(p256dh), auth: b64urlEncode(auth) },
    async decrypt(body: Uint8Array): Promise<string> {
      const salt = body.slice(0, 16);
      const idLen = body[20]!;
      const serverKey = body.slice(21, 21 + idLen);
      const peer = await crypto.subtle.importKey("raw", serverKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
      const ecdh = { name: "ECDH", public: peer } as unknown as SubtleCryptoDeriveKeyAlgorithm;
      const secret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, keys.privateKey, 256));
      const info = new Uint8Array([...enc("WebPush: info\0"), ...p256dh, ...serverKey]);
      const ikm = await hkdf(auth, secret, info, 32);
      const cek = await hkdf(salt, ikm, enc("Content-Encoding: aes128gcm\0"), 16);
      const nonce = await hkdf(salt, ikm, enc("Content-Encoding: nonce\0"), 12);
      const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idLen)),
      );
      expect(plain.at(-1)).toBe(2); // last-record delimiter
      return new TextDecoder().decode(plain.slice(0, -1));
    },
  };
}

afterEach(resetFakeModel);

describe("notifications", () => {
  it("reports which channels this server can deliver", async () => {
    const { token } = await setup();
    const config = (await (await api("/api/notifications/config", { token })).json()) as NotificationConfig;
    expect(config).toEqual({ webPushKey: env.VAPID_PUBLIC_KEY, email: true });
    expect((await api("/api/notifications/config")).status).toBe(401);
  });

  it("sends an encrypted, VAPID-signed Web Push and drops subscriptions the push service says are gone", async () => {
    const { token, agent, thread, project } = await setup();
    const browser = await fakeBrowser();
    const endpoint = `https://push.example.test/${crypto.randomUUID()}`;
    const reg = await api("/api/notifications/subscriptions", {
      method: "POST",
      token,
      body: JSON.stringify({ kind: "webpush", endpoint, keys: browser.keys }),
    });
    expect(reg.status).toBe(201);

    await agent.notifyThread(thread.id, "done", "The **notes** are ready.");
    const push = outbound.find((o) => o.url === endpoint)!;
    expect(push.headers.get("content-encoding")).toBe("aes128gcm");
    expect(push.headers.get("urgency")).toBe("high");
    expect(JSON.parse(await browser.decrypt(push.body))).toEqual({
      title: "Finished · Release notes",
      body: "The notes are ready.",
      url: `/projects/${project.id}/threads/${thread.id}`,
      tag: thread.id,
      project: "Myrel",
    });

    // The VAPID JWT is signed by the server's key, for the push service's origin.
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(push.headers.get("authorization")!)!;
    expect(k).toBe(env.VAPID_PUBLIC_KEY);
    const [header, claims, sig] = jwt!.split(".");
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(claims!)))).toMatchObject({
      aud: "https://push.example.test",
      sub: "mailto:test@example.com",
    });
    const pub = await crypto.subtle.importKey("raw", b64urlDecode(k!), { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      b64urlDecode(sig!),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(ok).toBe(true);

    // A 410 from the push service removes the subscription, so the next notification skips it.
    pushStatus.set(endpoint, 410);
    await agent.notifyThread(thread.id, "ready", "again");
    outbound.length = 0;
    await agent.notifyThread(thread.id, "ready", "and again");
    expect(outbound.some((o) => o.url === endpoint)).toBe(false);
  });

  it("delivers to Expo for the mobile app and respects each member's settings", async () => {
    const { token, agent, thread } = await setup();
    const register = (t: string) =>
      api("/api/notifications/subscriptions", {
        method: "POST",
        token,
        body: JSON.stringify({ kind: "expo", token: t }),
      });
    await register("ExponentPushToken[ok-device]");
    await register("ExponentPushToken[Gone-device]");

    await agent.notifyThread(thread.id, "blocked", "Need the API key.");
    const expo = outbound.find((o) => o.url.startsWith("https://exp.host/"))!;
    const sent = JSON.parse(new TextDecoder().decode(expo.body)) as {
      to: string;
      title: string;
      data: { threadId: string };
    }[];
    expect(sent.map((m) => m.to).sort()).toEqual(["ExponentPushToken[Gone-device]", "ExponentPushToken[ok-device]"]);
    expect(sent[0]).toMatchObject({ title: "Blocked · Release notes", data: { threadId: thread.id } });
    expect(emails).toHaveLength(1);

    // Defaults are on; turning both off leaves only the in-app list.
    expect(await (await api("/api/notifications/settings", { token })).json()).toEqual({ email: true, push: true });
    const put = await api("/api/notifications/settings", {
      method: "PUT",
      token,
      body: JSON.stringify({ email: false, push: false }),
    });
    expect((await put.json()) as NotificationSettings).toEqual({ email: false, push: false });
    outbound.length = 0;
    emails.length = 0;
    await agent.notifyThread(thread.id, "decision", "Ship it?");
    expect(outbound).toEqual([]);
    expect(emails).toEqual([]);

    // DeviceNotRegistered tokens were dropped; the good one remains.
    await api("/api/notifications/settings", { method: "PUT", token, body: JSON.stringify({ push: true }) });
    await agent.notifyThread(thread.id, "ready", "Done.");
    const again = JSON.parse(
      new TextDecoder().decode(outbound.find((o) => o.url.startsWith("https://exp.host/"))!.body),
    ) as {
      to: string;
    }[];
    expect(again.map((m) => m.to)).toEqual(["ExponentPushToken[ok-device]"]);

    const list = (await (await api("/api/notifications", { token })).json()) as { notifications: { kind: string }[] };
    expect(list.notifications.map((n) => n.kind).sort()).toEqual(["blocked", "decision", "ready"]);
  });
});
