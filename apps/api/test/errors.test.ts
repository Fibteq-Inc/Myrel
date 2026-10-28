import type { AdminErrorGroup, AdminFunnel } from "@myrel/protocol";
import { env as testEnv } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { normalizeMessage, pruneErrors, recordError } from "../src/errors";

const BASE = "http://myrel.test";
// Secrets are injected by vitest.config.ts, so the generated binding types do not list them.
const env = testEnv as unknown as Env;

function api(path: string, init: Omit<RequestInit, "body"> & { token?: string; body?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers, body }));
}

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

type TestUser = { token: string; email: string; id: string };

async function signUp(email = `u${crypto.randomUUID()}@example.com`, name = "Test"): Promise<TestUser> {
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: "correct-horse-battery", name },
  });
  expect(res.status).toBe(200);
  const { user } = (await res.json()) as { user: { id: string } };
  return { token: res.headers.get("set-auth-token")!, email, id: user.id };
}

async function makeAdmin(u: TestUser) {
  await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(u.id).run();
}


describe("error groups", () => {
  it("groups the same failure with different ids and counts it", () => {
    expect(normalizeMessage("Thread thr_01M61BW500P0D3S6E5BS not found after 30 s")).toBe(
      normalizeMessage("Thread thr_01M61CQDQWWCX014DHKJ6T not found after 12 s"),
    );
  });

  it("are counted, listed for admins only, cleared and pruned", async () => {
    const where = `test ${crypto.randomUUID()}`;
    await recordError(env, "agent", where, new Error("model said 429 for req_0123456789abcdef"));
    await recordError(env, "agent", where, new Error("model said 503 for req_fedcba9876543210"));
    await recordError(env, "agent", where, new TypeError("other"));

    const user = await signUp();
    expect((await api("/api/admin/errors", { token: user.token })).status).toBe(403);
    await makeAdmin(user);
    const list = async () =>
      (await json<{ errors: AdminErrorGroup[] }>(api("/api/admin/errors", { token: user.token }))).errors.filter(
        (e) => e.where === where,
      );
    const groups = await list();
    expect(groups.map((g) => [g.name, g.count]).sort()).toEqual([
      ["Error", 2],
      ["TypeError", 1],
    ]);
    expect(groups.find((g) => g.name === "Error")!.message).toBe("model said 503 for req_fedcba9876543210");

    await json(api(`/api/admin/errors/${groups[0]!.id}`, { method: "DELETE", token: user.token }), 204);
    expect(await list()).toHaveLength(1);
    await pruneErrors(env, Date.now() + 91 * 24 * 60 * 60 * 1000);
    expect(await list()).toHaveLength(0);
  });
});

describe("funnel", () => {
  it("counts how far newcomers got", async () => {
    const admin = await signUp();
    await makeAdmin(admin);
    const funnel = () => json<{ funnel: AdminFunnel }>(api("/api/admin/funnel?days=1", { token: admin.token }));
    const before = (await funnel()).funnel;
    const user = await signUp();
    await json(api("/api/projects", { method: "POST", token: user.token, body: { name: "P" } }), 201);
    const after = (await funnel()).funnel;
    expect(after.days).toBe(1);
    expect(after.signedUp - before.signedUp).toBe(1);
    expect(after.inProject - before.inProject).toBe(1);
    expect(after.pairedComputer - before.pairedComputer).toBe(0);
  });
});
