import type { BillingSummary, Project } from "@myrel/protocol";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { billingExtensions } from "../src/limits";
import { freeSpendMicros } from "../src/store";
import { encodeForm, hmacHex, verifyWebhook } from "../src/stripe";

const BASE = "http://myrel.test";
/** The test bindings, typed as the Worker's own. */
const workerEnv = env as unknown as Env;

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function signUp(email = `u${crypto.randomUUID()}@example.com`) {
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "Test", acceptTerms: true }),
  });
  const token = res.headers.get("set-auth-token")!;
  const me = (await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } };
  return { token, email, userId: me.user.id };
}

const createProject = (token: string, name = "P") => api("/api/projects", { method: "POST", token, body: JSON.stringify({ name }) });

async function webhook(event: unknown, secret = "whsec_test") {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const signature = await hmacHex(secret, `${t}.${payload}`);
  return api("/api/billing/webhook", { method: "POST", body: payload, headers: { "stripe-signature": `t=${t},v1=${signature}` } });
}

function subscriptionEvent(userId: string, lookupKey: string, status = "active", extra: Record<string, unknown> = {}) {
  return {
    id: `evt_${crypto.randomUUID()}`,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: `sub_${userId}`,
        customer: `cus_${userId}`,
        status,
        cancel_at_period_end: false,
        trial_end: null,
        metadata: { user_id: userId },
        items: {
          data: [
            {
              id: "si_1",
              quantity: 1,
              current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
              price: { id: "price_1", lookup_key: lookupKey, recurring: { interval: "month" } },
            },
          ],
        },
        ...extra,
      },
    },
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("hosted billing", () => {
  it("tells clients this server sells plans and which terms sign-up accepts", async () => {
    expect(await (await api("/api/info")).json()).toMatchObject({
      billing: true,
      legal: { terms: `${BASE}/terms/`, privacy: `${BASE}/privacy/`, version: "2026-10-20" },
    });
  });

  it("requires accepting the terms at sign-up and records which version", async () => {
    const body = { email: `u${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "Test" };
    const refused = await api("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify(body) });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "TERMS_NOT_ACCEPTED" });
    const { userId } = await signUp();
    const row = await env.DB.prepare("SELECT terms_accepted_at, terms_version FROM user WHERE id = ?").bind(userId).first();
    expect(row).toMatchObject({ terms_version: "2026-10-20" });
    expect(row?.terms_accepted_at).toBeGreaterThan(Date.now() - 60_000);
  });

  it("limits Free to three projects and lifts it when a Pro subscription arrives", async () => {
    const { token, userId } = await signUp();
    for (const name of ["a", "b", "c"]) expect((await createProject(token, name)).status).toBe(201);
    const refused = await createProject(token, "d");
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { message: string }).message).toContain("3 projects");

    const event = subscriptionEvent(userId, "myrel_pro_monthly");
    expect((await webhook(event)).status).toBe(200);
    // A redelivery is ignored.
    expect(await (await webhook(event)).json()).toMatchObject({ duplicate: true });

    const summary = (await (await api("/api/billing", { token })).json()) as BillingSummary;
    expect(summary).toMatchObject({ plan: "pro", status: "active", interval: "month", owner: true, trialAvailable: true });
    expect(summary.limits.projects).toBeNull();
    expect(summary.usage.projects).toBe(3);
    expect((await createProject(token, "d")).status).toBe(201);

    // Canceled: back to Free, nothing deleted, but no new projects over the limit.
    await webhook(subscriptionEvent(userId, "myrel_pro_monthly", "canceled"));
    expect(((await (await api("/api/billing", { token })).json()) as BillingSummary).plan).toBe("free");
    expect((await createProject(token, "e")).status).toBe(402);
  });

  it("never limits the server's admins and leaves their use out of the Free budget", async () => {
    const { token, userId: adminId } = await signUp("admin@example.com");
    const summary = (await (await api("/api/billing", { token })).json()) as BillingSummary;
    expect(summary).toMatchObject({
      plan: "admin",
      limits: { projects: null, sandboxSeconds: null, modelMicros: null, connectors: null },
    });

    for (const name of ["A", "B", "C", "D"]) expect((await createProject(token, name)).status).toBe(201);
    const project = ((await (await createProject(token)).json()) as { project: Project }).project;
    const before = await freeSpendMicros(workerEnv);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sandbox_runs (id, project_id, thread_id, started_at, ended_at, seconds, billed_to) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(`task_${crypto.randomUUID()}`, project.id, "thread_1", now - 360_000_000, now, 360_000, adminId),
      env.DB.prepare(
        `INSERT INTO usage_events (id, created_at, project_id, agent, turn_id, provider, model, input_tokens, output_tokens, cost_micros, latency_ms, billed_to, service_key)
         VALUES (?, ?, ?, 'thread', 't', 'fireworks', 'm', 1, 1, 100000000, 1, ?, 1)`,
      ).bind(`usage_${crypto.randomUUID()}`, now, project.id, adminId),
    ]);
    expect(await billingExtensions.canUseSandbox!(workerEnv, project.id)).toEqual({ ok: true });
    expect(await billingExtensions.canUseCoordinator!(workerEnv, project.id)).toEqual({ ok: true });
    expect(await freeSpendMicros(workerEnv)).toBe(before);
  });

  it("rejects webhooks without a valid signature", async () => {
    const res = await webhook(subscriptionEvent("x", "myrel_pro_monthly"), "whsec_wrong");
    expect(res.status).toBe(400);
  });

  it("stops cloud sandbox and model use at the plan's monthly allowance", async () => {
    const { token, userId } = await signUp();
    const project = ((await (await createProject(token)).json()) as { project: Project }).project;
    expect(await billingExtensions.canUseSandbox!(workerEnv, project.id)).toEqual({ ok: true });
    expect(await billingExtensions.canUseCoordinator!(workerEnv, project.id)).toEqual({ ok: true });

    const now = Date.now();
    await env.DB.prepare("INSERT INTO sandbox_runs (id, project_id, thread_id, started_at, ended_at, seconds, billed_to) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(`task_${crypto.randomUUID()}`, project.id, "thread_1", now - 7200_000, now, 7200, userId)
      .run();
    const sandbox = await billingExtensions.canUseSandbox!(workerEnv, project.id);
    expect(sandbox.ok || sandbox.reason).toContain("2 hours");
    expect(await billingExtensions.canUseCoordinator!(workerEnv, project.id)).toEqual({ ok: true });

    // The cloud thread agent's model calls on the service's key count too: $1 is Free's allowance.
    await env.DB.prepare(
      `INSERT INTO usage_events (id, created_at, project_id, agent, turn_id, provider, model, input_tokens, output_tokens, cost_micros, latency_ms, billed_to, service_key)
       VALUES (?, ?, ?, 'thread', 't', 'fireworks', 'm', 1, 1, 1000000, 1, ?, 1)`,
    )
      .bind(`usage_${crypto.randomUUID()}`, now, project.id, userId)
      .run();
    const coordinator = await billingExtensions.canUseCoordinator!(workerEnv, project.id);
    expect(coordinator.ok || coordinator.reason).toContain("model usage");

    // Deleting the project that used it does not give the month back.
    const fresh = ((await (await createProject(token, "Fresh")).json()) as { project: Project }).project;
    expect((await api(`/api/projects/${project.id}`, { method: "DELETE", token })).status).toBe(204);
    const after = await billingExtensions.canUseCoordinator!(workerEnv, fresh.id);
    expect(after.ok || after.reason).toContain("model usage");

    // A project with its own model key pays for its coordinator itself.
    const keyId = `key_${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO api_keys (id, owner_id, provider, label, secret, hint) VALUES (?, ?, 'fireworks', 'Own', 'x', 'x')").bind(keyId, userId),
      env.DB.prepare("UPDATE projects SET llm_key_id = ? WHERE id = ?").bind(keyId, fresh.id),
    ]);
    expect(await billingExtensions.canUseCoordinator!(workerEnv, fresh.id)).toEqual({ ok: true });
  });

  it("sets a Team switched to in the billing portal to at least two seats", async () => {
    const { userId } = await signUp();
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.stripe.com/")) return realFetch(input, init);
      calls.push({ url, body: String(init?.body ?? "") });
      const event = subscriptionEvent(userId, "myrel_team_monthly");
      event.data.object.items.data[0]!.quantity = 2;
      return Response.json(event.data.object);
    };
    expect((await webhook(subscriptionEvent(userId, "myrel_team_monthly"))).status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([`https://api.stripe.com/v1/subscriptions/sub_${userId}`]);
    expect(new URLSearchParams(calls[0]!.body).get("items[0][quantity]")).toBe("2");
    const seats = await env.DB.prepare("SELECT seats FROM billing_subscriptions WHERE user_id = ?").bind(userId).first<{ seats: number }>();
    expect(seats?.seats).toBe(2);
  });

  it("keeps a past_due plan for 14 days, then ends it on the next failed payment", async () => {
    const { token, userId } = await signUp();
    for (const name of ["a", "b", "c"]) expect((await createProject(token, name)).status).toBe(201);
    expect((await webhook(subscriptionEvent(userId, "myrel_pro_monthly", "past_due"))).status).toBe(200);
    expect((await createProject(token, "d")).status).toBe(201);

    // Fifteen days later the grace period is over: Free limits apply and the next failure cancels.
    await env.DB.prepare("UPDATE billing_subscriptions SET past_due_since = ? WHERE user_id = ?").bind(Date.now() - 15 * 86400_000, userId).run();
    expect((await createProject(token, "e")).status).toBe(402);
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.stripe.com/")) return realFetch(input, init);
      calls.push({ url, method: init?.method ?? "GET" });
      return Response.json(subscriptionEvent(userId, "myrel_pro_monthly", "canceled").data.object);
    };
    const failed = {
      id: `evt_${crypto.randomUUID()}`,
      type: "invoice.payment_failed",
      data: { object: { id: "in_1", parent: { subscription_details: { subscription: `sub_${userId}` } } } },
    };
    expect((await webhook(failed)).status).toBe(200);
    expect(calls).toEqual([{ url: `https://api.stripe.com/v1/subscriptions/sub_${userId}`, method: "DELETE" }]);
    const row = await env.DB.prepare("SELECT status, past_due_since FROM billing_subscriptions WHERE user_id = ?").bind(userId).first();
    expect(row).toEqual({ status: "canceled", past_due_since: null });
  });

  it("allows two connectors on Free, counting the person's own and their projects'", async () => {
    const { token, userId } = await signUp();
    const project = ((await (await createProject(token)).json()) as { project: Project }).project;
    const add = (column: "owner_id" | "project_id", value: string) =>
      env.DB.prepare(`INSERT INTO connectors (id, ${column}, name, slug, transport) VALUES (?, ?, 'C', 'c', 'http')`)
        .bind(`connector_${crypto.randomUUID()}`, value)
        .run();
    expect(await billingExtensions.canAddConnector!(workerEnv, { userId })).toEqual({ ok: true });
    await add("owner_id", userId);
    await add("project_id", project.id);
    const refused = await billingExtensions.canAddConnector!(workerEnv, { projectId: project.id });
    expect(refused.ok || refused.reason).toContain("2 connectors");
    await webhook(subscriptionEvent(userId, "myrel_pro_monthly"));
    expect(await billingExtensions.canAddConnector!(workerEnv, { userId })).toEqual({ ok: true });
  });

  it("keeps a person's own plan first when a Team owner adds them, and lets them leave", async () => {
    const owner = await signUp();
    await webhook(subscriptionEvent(owner.userId, "myrel_team_monthly"));
    const stripeCalls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.stripe.com/")) return realFetch(input, init);
      stripeCalls.push(url);
      return Response.json(subscriptionEvent(owner.userId, "myrel_team_monthly").data.object);
    };
    const addMember = (email: string) => api("/api/billing/team/members", { method: "POST", token: owner.token, body: JSON.stringify({ email }) });
    const paying = await signUp();
    await webhook(subscriptionEvent(paying.userId, "myrel_pro_monthly"));
    expect((await addMember(paying.email)).status).toBe(409);

    const free = await signUp();
    expect((await addMember(free.email)).status).toBe(204);
    const plan = async (token: string) => ((await (await api("/api/billing", { token })).json()) as BillingSummary).plan;
    expect(await plan(free.token)).toBe("team");
    expect((await api("/api/billing/team/membership", { method: "DELETE", token: free.token })).status).toBe(204);
    expect(await plan(free.token)).toBe("free");
  });

  it("gives no second trial to an address whose account was deleted", async () => {
    const first = await signUp();
    const trial = subscriptionEvent(first.userId, "myrel_pro_monthly", "trialing", { trial_end: Math.floor(Date.now() / 1000) + 7 * 86400 });
    expect((await webhook(trial)).status).toBe(200);
    expect((await api("/api/account", { method: "DELETE", token: first.token })).status).toBe(204);

    const again = await signUp(first.email.replace("@", "+again@").toUpperCase());
    const summary = (await (await api("/api/billing", { token: again.token })).json()) as BillingSummary;
    expect(summary.trialAvailable).toBe(false);
  });

  it("offers a trial only to a verified address", async () => {
    const { token, userId } = await signUp();
    await env.DB.prepare("UPDATE user SET email_verified = 0 WHERE id = ?").bind(userId).run();
    const res = await api("/api/billing/checkout", { method: "POST", token, body: JSON.stringify({ plan: "pro" }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "email_not_verified" });
  });

  it("opens a Checkout with a seven-day trial and tax for a first subscription", async () => {
    const { token } = await signUp();
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.stripe.com/")) return realFetch(input, init);
      calls.push({ url, body: String(init?.body ?? "") });
      const reply = url.includes("/customers")
        ? { id: "cus_new" }
        : url.includes("/prices")
          ? { data: [{ id: "price_pro" }] }
          : { url: "https://checkout.stripe.test/session" };
      return Response.json(reply);
    };
    const res = await api("/api/billing/checkout", { method: "POST", token, body: JSON.stringify({ plan: "pro", interval: "month" }) });
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.test/session" });
    const prices = calls.find((c) => c.url.includes("/prices"))!;
    expect(decodeURIComponent(prices.url)).toContain("lookup_keys[0]=myrel_pro_monthly");
    const session = new URLSearchParams(calls.find((c) => c.url.endsWith("/checkout/sessions"))!.body);
    expect(session.get("customer")).toBe("cus_new");
    expect(session.get("line_items[0][price]")).toBe("price_pro");
    expect(session.get("subscription_data[trial_period_days]")).toBe("7");
    expect(session.get("automatic_tax[enabled]")).toBe("true");
    expect(session.get("payment_method_collection")).toBe("if_required");
  });
});

describe("stripe helpers", () => {
  it("encodes nested params the way Stripe expects", () => {
    expect(decodeURIComponent(encodeForm({ a: { b: 1 }, c: [{ d: "x" }], e: ["y"], skip: undefined }).toString())).toBe(
      "a[b]=1&c[0][d]=x&e[0]=y",
    );
  });

  it("refuses stale webhook timestamps", async () => {
    const t = Math.floor(Date.now() / 1000) - 3600;
    const sig = await hmacHex("s", `${t}.{}`);
    expect(await verifyWebhook("{}", `t=${t},v1=${sig}`, "s")).toBe(false);
    expect(await verifyWebhook("{}", `t=${t},v1=${sig}`, "s", t * 1000)).toBe(true);
  });
});
