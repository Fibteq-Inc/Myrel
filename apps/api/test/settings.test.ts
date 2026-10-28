import type { ApiKey, Invite, Member, Project, ProjectSettings } from "@myrel/protocol";
import { env as testEnv } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/crypto";
import { projectProvider } from "../src/keys";
import { emails } from "./fake-llm";

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

async function createProject(token: string): Promise<Project> {
  return (await json<{ project: Project }>(api("/api/projects", { method: "POST", token, body: { name: "P" } }), 201))
    .project;
}

describe("key encryption", () => {
  it("round-trips and is bound to its row", async () => {
    const sealed = await encryptSecret(env, "sk-secret-value", "key_1");
    expect(sealed).not.toContain("sk-secret-value");
    expect(await decryptSecret(env, sealed, "key_1")).toBe("sk-secret-value");
    await expect(decryptSecret(env, sealed, "key_2")).rejects.toThrow();
  });
});

describe("model keys", () => {
  it("stores keys encrypted and shows only a hint to their owner", async () => {
    const alice = await signUp();
    const bob = await signUp();
    const res = await api("/api/account/keys", {
      method: "POST",
      token: alice.token,
      body: { provider: "anthropic", label: "Mine", key: "sk-ant-abcdefgh1234" },
    });
    const text = await res.text();
    expect(res.status).toBe(201);
    expect(text).not.toContain("sk-ant-abcdefgh1234");
    const { key } = JSON.parse(text) as { key: ApiKey };
    expect(key).toMatchObject({ provider: "anthropic", label: "Mine", hint: "…1234", scope: "user" });

    const row = await env.DB.prepare("SELECT secret FROM api_keys WHERE id = ?").bind(key.id).first<{ secret: string }>();
    expect(row!.secret).toMatch(/^v1:/);
    expect(row!.secret).not.toContain("abcdefgh");

    const list = (token: string) => json<{ keys: ApiKey[] }>(api("/api/account/keys", { token }));
    expect((await list(alice.token)).keys.map((k) => k.id)).toContain(key.id);
    expect((await list(bob.token)).keys.map((k) => k.id)).not.toContain(key.id);
    expect((await api(`/api/account/keys/${key.id}`, { method: "DELETE", token: bob.token })).status).toBe(404);
    expect((await api(`/api/account/keys/${key.id}`, { method: "DELETE", token: alice.token })).status).toBe(204);
  });

  it("lets only admins add instance keys", async () => {
    const user = await signUp();
    const body = { provider: "openai", label: "Shared", key: "sk-openai-1234567", scope: "instance" };
    expect((await api("/api/account/keys", { method: "POST", token: user.token, body })).status).toBe(403);
    await makeAdmin(user);
    const { key } = await json<{ key: ApiKey }>(api("/api/account/keys", { method: "POST", token: user.token, body }), 201);
    expect(key.scope).toBe("instance");
    const other = await signUp();
    expect((await json<{ keys: ApiKey[] }>(api("/api/account/keys", { token: other.token }))).keys.map((k) => k.id)).toContain(
      key.id,
    );
    await api(`/api/account/keys/${key.id}`, { method: "DELETE", token: user.token });
  });

  it("lists providers", async () => {
    const user = await signUp();
    const { providers } = await json<{ providers: { id: string; serverKey: boolean }[] }>(
      api("/api/account/providers", { token: user.token }),
    );
    expect(providers.map((p) => p.id)).toEqual(["fireworks", "anthropic", "openai"]);
    expect(providers.find((p) => p.id === "fireworks")!.serverKey).toBe(true);
  });
});

describe("project settings", () => {
  it("picks a provider, model and key, and agents call the model with that key", async () => {
    const alice = await signUp();
    const bob = await signUp();
    const project = await createProject(alice.token);
    const addKey = async (u: TestUser, key: string) =>
      (
        await json<{ key: ApiKey }>(
          api("/api/account/keys", { method: "POST", token: u.token, body: { provider: "anthropic", label: "k", key } }),
          201,
        )
      ).key;
    const aliceKey = await addKey(alice, "sk-ant-alice-123456");
    const bobKey = await addKey(bob, "sk-ant-bob-1234567");

    const patch = (token: string, body: unknown) => api(`/api/projects/${project.id}/settings`, { method: "PATCH", token, body });
    // Someone else's key cannot be attached.
    expect((await patch(alice.token, { keyId: bobKey.id })).status).toBe(400);
    const { settings } = await json<{ settings: ProjectSettings }>(
      patch(alice.token, { keyId: aliceKey.id, model: "claude-opus-5-5", name: "Renamed" }),
    );
    expect(settings).toEqual({
      name: "Renamed",
      provider: "anthropic",
      model: "claude-opus-5-5",
      keyId: aliceKey.id,
      taskTarget: "auto",
      icon: null,
      color: null,
      cloudCli: "opencode",
      cliModels: {},
    });
    const claude = await json<{ settings: ProjectSettings }>(patch(alice.token, { cloudCli: "claude" }));
    expect(claude.settings.cloudCli).toBe("claude");
    expect((await patch(alice.token, { cloudCli: "gemini" })).status).toBe(400);
    expect((await json<{ settings: ProjectSettings }>(patch(alice.token, { cloudCli: "opencode" }))).settings.cloudCli).toBe("opencode");
    const cloud = await json<{ settings: ProjectSettings }>(patch(alice.token, { taskTarget: "cloud" }));
    expect(cloud.settings.taskTarget).toBe("cloud");
    expect((await patch(alice.token, { taskTarget: "moon" })).status).toBe(400);

    let seen: { url: string; key: string | null; model: string } | undefined;
    const llm = await projectProvider(env, project.id, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { model: string };
      seen = { url: String(input), key: new Headers(init!.headers).get("x-api-key"), model: body.model };
      return Response.json({ content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 1 } });
    }) as typeof fetch);
    expect(llm.ok).toBe(true);
    if (!llm.ok) return;
    await llm.provider.chat({ system: "s", turns: [{ role: "user", content: "hi" }], tools: [] });
    expect(seen).toEqual({ url: "https://api.anthropic.com/v1/messages", key: "sk-ant-alice-123456", model: "claude-opus-5-5" });

    // Switching provider drops the key of the old one; with no key the project explains what to add.
    const switched = await json<{ settings: ProjectSettings }>(patch(alice.token, { provider: "openai", model: null }));
    expect(switched.settings).toMatchObject({ provider: "openai", keyId: null, model: null });
    const missing = await projectProvider(env, project.id);
    expect(missing).toMatchObject({ ok: false });

    // Back to the server default.
    await json(patch(alice.token, { provider: null }));
    expect((await projectProvider(env, project.id)).ok).toBe(true);
  });

  it("marks a project with an icon and a color every member sees, set by those who manage it", async () => {
    const alice = await signUp();
    const bob = await signUp();
    const project = await createProject(alice.token);
    const base = `/api/projects/${project.id}`;
    const patch = (token: string, body: unknown) => api(`${base}/settings`, { method: "PATCH", token, body });

    const { settings } = await json<{ settings: ProjectSettings }>(patch(alice.token, { icon: "rocket", color: "teal" }));
    expect(settings).toMatchObject({ icon: "rocket", color: "teal" });
    expect((await patch(alice.token, { icon: "unicorn" })).status).toBe(400);
    expect((await patch(alice.token, { color: "#ff0000" })).status).toBe(400);

    // Members see it in the project and the project list, but cannot change it.
    const { invite } = await json<{ invite: Invite }>(
      api(`${base}/invites`, { method: "POST", token: alice.token, body: { email: bob.email } }),
      201,
    );
    await json(api(`/api/account/invites/${invite.id}/accept`, { method: "POST", token: bob.token }));
    expect((await json<{ project: Project }>(api(base, { token: bob.token }))).project).toMatchObject({ icon: "rocket", color: "teal" });
    const listed = await json<{ projects: Project[] }>(api("/api/projects", { token: bob.token }));
    expect(listed.projects.find((p) => p.id === project.id)).toMatchObject({ icon: "rocket", color: "teal" });
    expect((await patch(bob.token, { color: "red" })).status).toBe(403);

    // null goes back to the first letter and the accent color.
    const reset = await json<{ settings: ProjectSettings }>(patch(alice.token, { icon: null, color: null }));
    expect(reset.settings).toMatchObject({ icon: null, color: null });
  });
});

describe("members and invites", () => {
  it("invites by email, manages roles and protects the last owner", async () => {
    const alice = await signUp(undefined, "Alice");
    const bob = await signUp(undefined, "Bob");
    const project = await createProject(alice.token);
    const base = `/api/projects/${project.id}`;

    const { invite } = await json<{ invite: Invite }>(
      api(`${base}/invites`, { method: "POST", token: alice.token, body: { email: bob.email.toUpperCase() } }),
      201,
    );
    expect(invite).toMatchObject({ email: bob.email, role: "member", invitedBy: "Alice", projectName: "P" });
    // Bob sees it and accepts.
    const mine = await json<{ invites: Invite[] }>(api("/api/account/invites", { token: bob.token }));
    expect(mine.invites.map((i) => i.id)).toEqual([invite.id]);
    expect(await json(api(`/api/account/invites/${invite.id}/accept`, { method: "POST", token: bob.token }))).toEqual({
      projectId: project.id,
    });
    expect((await json<{ invites: Invite[] }>(api("/api/account/invites", { token: bob.token }))).invites).toEqual([]);
    // Inviting a member again is refused.
    expect((await api(`${base}/invites`, { method: "POST", token: alice.token, body: { email: bob.email } })).status).toBe(409);

    // Members see each other but not emails; owners see emails.
    const members = (token: string) => json<{ members: Member[] }>(api(`${base}/members`, { token }));
    expect((await members(bob.token)).members.every((m) => m.email === undefined)).toBe(true);
    expect((await members(alice.token)).members.map((m) => [m.name, m.role, m.email])).toEqual([
      ["Alice", "owner", alice.email],
      ["Bob", "member", bob.email],
    ]);

    // A member cannot manage; an admin can, but not owners.
    const carol = `c${crypto.randomUUID()}@example.com`;
    expect((await api(`${base}/invites`, { method: "POST", token: bob.token, body: { email: carol } })).status).toBe(403);
    expect((await api(`${base}/settings`, { method: "PATCH", token: bob.token, body: { name: "x" } })).status).toBe(403);
    await json(api(`${base}/members/${bob.id}`, { method: "PATCH", token: alice.token, body: { role: "admin" } }));
    await json(api(`${base}/invites`, { method: "POST", token: bob.token, body: { email: carol } }), 201);
    expect((await api(`${base}/members/${alice.id}`, { method: "DELETE", token: bob.token })).status).toBe(403);
    expect(
      (await api(`${base}/members/${bob.id}`, { method: "PATCH", token: bob.token, body: { role: "owner" } })).status,
    ).toBe(403);

    // The last owner can neither leave nor step down.
    expect((await api(`${base}/members/${alice.id}`, { method: "DELETE", token: alice.token })).status).toBe(409);
    expect(
      (await api(`${base}/members/${alice.id}`, { method: "PATCH", token: alice.token, body: { role: "member" } })).status,
    ).toBe(409);

    // Pending invites can be listed and revoked by managers; Bob can leave.
    const pending = await json<{ invites: Invite[] }>(api(`${base}/invites`, { token: alice.token }));
    expect(pending.invites.map((i) => i.email)).toEqual([carol]);
    expect((await api(`${base}/invites/${pending.invites[0]!.id}`, { method: "DELETE", token: alice.token })).status).toBe(204);
    // Bob, an admin, puts the project on his own key; leaving takes the key with him.
    const { key: bobKey } = await json<{ key: ApiKey }>(
      api("/api/account/keys", { method: "POST", token: bob.token, body: { provider: "anthropic", label: "k", key: "sk-ant-bob-1234567" } }),
      201,
    );
    await json(api(`${base}/settings`, { method: "PATCH", token: bob.token, body: { keyId: bobKey.id } }));
    expect((await api(`${base}/members/${bob.id}`, { method: "DELETE", token: bob.token })).status).toBe(204);
    expect((await api(base, { token: bob.token })).status).toBe(404);
    const keyId = await env.DB.prepare("SELECT llm_key_id AS k FROM projects WHERE id = ?").bind(project.id).first<{ k: string | null }>();
    expect(keyId?.k).toBeNull();
    // Even if it were still attached, a former member's key is not used.
    await env.DB.prepare("UPDATE projects SET llm_key_id = ? WHERE id = ?").bind(bobKey.id, project.id).run();
    expect(await projectProvider(env, project.id)).toMatchObject({ ok: false });
  });
});

describe("invitation emails", () => {
  it("emails the invitee a link, and says so when the email cannot go out", async () => {
    const alice = await signUp(undefined, "Alice");
    const bob = await signUp(undefined, "Bob");
    const project = await createProject(alice.token);
    const base = `/api/projects/${project.id}`;
    const to = (address: string) => emails.filter((m) => m.to === address);

    // Someone with an account is sent to their invitations.
    await json(api(`${base}/invites`, { method: "POST", token: alice.token, body: { email: bob.email } }), 201);
    expect(to(bob.email)).toHaveLength(1);
    expect(to(bob.email)[0]).toMatchObject({ subject: "Alice invited you to P on Myrel" });
    expect(to(bob.email)[0]!.text).toContain(`${BASE}/settings/invites`);

    // Someone without one is sent to sign up.
    const carol = `c${crypto.randomUUID()}@example.com`;
    await json(api(`${base}/invites`, { method: "POST", token: alice.token, body: { email: carol } }), 201);
    expect(to(carol)[0]!.text).toContain(`${BASE}/login?signup`);

    // A failed send is reported with its cause; the invitation stays.
    const proto = Object.getPrototypeOf(env.EMAIL) as { send: SendEmail["send"] };
    const send = proto.send;
    proto.send = async () => {
      throw Object.assign(new Error("sender not verified"), { code: "E_SENDER_NOT_VERIFIED" });
    };
    const dave = `d${crypto.randomUUID()}@example.com`;
    try {
      const failed = await json<{ error: string; message: string }>(
        api(`${base}/invites`, { method: "POST", token: alice.token, body: { email: dave } }),
        502,
      );
      expect(failed.error).toBe("invite_email_failed");
      expect(failed.message).toContain("E_SENDER_NOT_VERIFIED");
    } finally {
      proto.send = send;
    }
    const pending = await json<{ invites: Invite[] }>(api(`${base}/invites`, { token: alice.token }));
    expect(pending.invites.map((i) => i.email)).toContain(dave);
  });
});

describe("get started list", () => {
  it("is shown until the person finishes or hides it, once for the account", async () => {
    const user = await signUp();
    const me = () => json<{ user: { onboarded: boolean } }>(api("/api/account", { token: user.token }));
    expect((await me()).user.onboarded).toBe(false);
    await json(api("/api/account/onboarded", { method: "POST", token: user.token }), 204);
    await json(api("/api/account/onboarded", { method: "POST", token: user.token }), 204);
    expect((await me()).user.onboarded).toBe(true);
    expect((await api("/api/account/onboarded", { method: "POST" })).status).toBe(401);
  });

  it("remembers each one-time tip once seen", async () => {
    const user = await signUp();
    const tips = async () => (await json<{ user: { tips: string[] } }>(api("/api/account", { token: user.token }))).user.tips;
    expect(await tips()).toEqual([]);
    await json(api("/api/account/tips/decision", { method: "POST", token: user.token }), 204);
    await json(api("/api/account/tips/decision", { method: "POST", token: user.token }), 204);
    await json(api("/api/account/tips/computer", { method: "POST", token: user.token }), 204);
    expect(await tips()).toEqual(["decision", "computer"]);
    expect((await api("/api/account/tips/nope", { method: "POST", token: user.token })).status).toBe(404);
    expect((await api("/api/account/tips/decision", { method: "POST" })).status).toBe(401);
  });
});

describe("sign-up setting", () => {
  it("is an admin setting that invited people bypass", async () => {
    const admin = await signUp();
    const user = await signUp();
    expect((await api("/api/admin/settings", { token: user.token })).status).toBe(403);
    await makeAdmin(admin);
    expect(await json(api("/api/account", { token: admin.token }))).toEqual({
      user: { id: admin.id, name: "Test", email: admin.email, role: "admin", onboarded: false, tips: [] },
    });

    const set = (signUpEnabled: boolean) =>
      json<{ settings: { signUpEnabled: boolean } }>(
        api("/api/admin/settings", { method: "PATCH", token: admin.token, body: { signUpEnabled } }),
      );
    try {
      expect((await set(false)).settings.signUpEnabled).toBe(false);
      expect(((await json<{ auth: { signUp: boolean } }>(api("/api/info"))).auth.signUp)).toBe(false);
      const refused = await api("/api/auth/sign-up/email", {
        method: "POST",
        body: { email: `n${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "New" },
      });
      expect(refused.status).toBe(403);

      const project = await createProject(admin.token);
      const invited = `i${crypto.randomUUID()}@example.com`;
      await json(api(`/api/projects/${project.id}/invites`, { method: "POST", token: admin.token, body: { email: invited } }), 201);
      const guest = await signUp(invited);
      const { invites } = await json<{ invites: Invite[] }>(api("/api/account/invites", { token: guest.token }));
      expect(invites).toHaveLength(1);
    } finally {
      await set(true);
    }
  });
});
