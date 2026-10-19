import type { GithubRepo, GithubStatus, Project, ProjectRepo } from "@altair/protocol";
import { env as testEnv } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { appJwt, pemToPkcs8 } from "../src/github/app";
import { listRepoFiles, readRepoFile } from "../src/github/files";
import { safeReturnTo, signState, verifyState } from "../src/github/state";
import { fakeGithub } from "./fake-github";

const BASE = "http://altair.test";
// The GitHub settings are secrets (src/env.d.ts), which the generated test Env does not list.
const env = testEnv as Env;

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers, redirect: "manual" }));
}

async function signUp() {
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email: `u${crypto.randomUUID()}@example.com`, password: "correct-horse-battery", name: "Test" }),
  });
  return res.headers.get("set-auth-token")!;
}

async function createProject(token: string): Promise<Project> {
  const res = await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Repo project" }) });
  return ((await res.json()) as { project: Project }).project;
}

/** Runs the connect round trip the way a browser would and returns where it lands. */
async function connect(token: string, opts: { mode?: string; code?: string; stateFrom?: string } = {}) {
  const start = await api(`/api/github/connect?returnTo=${encodeURIComponent("/projects/x?settings=1")}&mode=${opts.mode ?? "install"}`, {
    token: opts.stateFrom ?? token,
  });
  expect(start.status).toBe(302);
  const githubUrl = new URL(start.headers.get("location")!);
  const state = githubUrl.searchParams.get("state")!;
  const cb = await api(`/api/github/callback?code=${opts.code ?? "good-code"}&installation_id=42&setup_action=install&state=${encodeURIComponent(state)}`, {
    token,
  });
  return { githubUrl, landed: cb.headers.get("location") };
}

async function signWebhook(body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-webhook-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...sig].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("github helpers", () => {
  it("signs and verifies connect state", async () => {
    const s = await signState("secret", { userId: "u1", returnTo: "/projects/p" });
    expect(await verifyState("secret", s)).toEqual({ userId: "u1", returnTo: "/projects/p" });
    expect(await verifyState("other-secret", s)).toBeNull();
    expect(await verifyState("secret", `${s}x`)).toBeNull();
  });

  it("only returns to same-site paths", () => {
    expect(safeReturnTo("/projects/p")).toBe("/projects/p");
    expect(safeReturnTo("//evil.example")).toBe("/");
    expect(safeReturnTo("https://evil.example")).toBe("/");
    expect(safeReturnTo(undefined)).toBe("/");
  });

  it("signs an app JWT with GitHub's PKCS#1 key", async () => {
    const jwt = await appJwt(env);
    const [header, payload] = jwt.split(".").slice(0, 2).map((p) => JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/"))));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe("1234");
    expect(env.GITHUB_APP_PRIVATE_KEY).toContain("BEGIN RSA PRIVATE KEY");
    expect(pemToPkcs8(env.GITHUB_APP_PRIVATE_KEY!).byteLength).toBeGreaterThan(1000);
  });
});

describe("connecting GitHub", () => {
  it("reports whether the app is configured", async () => {
    const token = await signUp();
    const status = (await (await api("/api/github", { token })).json()) as GithubStatus;
    expect(status).toEqual({ configured: true, installUrl: "https://github.com/apps/altair-test/installations/new", installations: [] });
  });

  it("installs, then remembers the installations GitHub confirms", async () => {
    const token = await signUp();
    const { githubUrl, landed } = await connect(token);
    expect(githubUrl.origin + githubUrl.pathname).toBe("https://github.com/apps/altair-test/installations/new");
    expect(landed).toBe("/projects/x?settings=1&github=connected");

    const status = (await (await api("/api/github", { token })).json()) as GithubStatus;
    expect(status.installations).toEqual([
      { id: 42, accountLogin: "acme", accountType: "Organization", accountAvatarUrl: "https://avatars.test/acme" },
    ]);
    const { repos } = (await (await api("/api/github/repos", { token })).json()) as { repos: GithubRepo[] };
    expect(repos.map((r) => r.fullName)).toEqual(["acme/app", "acme/docs"]);
  });

  it("can sign in to GitHub without installing", async () => {
    const { githubUrl, landed } = await connect(await signUp(), { mode: "authorize" });
    expect(githubUrl.pathname).toBe("/login/oauth/authorize");
    expect(githubUrl.searchParams.get("client_id")).toBe("Iv1.test");
    expect(landed).toContain("github=connected");
  });

  it("refuses a state that belongs to another user", async () => {
    const alice = await signUp();
    const bob = await signUp();
    const { landed } = await connect(bob, { stateFrom: alice });
    expect(landed).toBe("/?github=invalid_state");
    expect(((await (await api("/api/github", { token: bob })).json()) as GithubStatus).installations).toEqual([]);
  });

  it("reports a failed GitHub sign-in", async () => {
    const { landed } = await connect(await signUp(), { code: "bad-code" });
    expect(landed).toContain("github=error");
  });
});

describe("project repositories", () => {
  it("connects, lists and removes repositories", async () => {
    const token = await signUp();
    await connect(token);
    const project = await createProject(token);
    const add = (repoId: number, t = token) =>
      api(`/api/projects/${project.id}/repos`, { method: "POST", token: t, body: JSON.stringify({ installationId: 42, repoId }) });

    const res = await add(7);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { repo: ProjectRepo }).repo).toMatchObject({
      repoId: 7,
      fullName: "acme/app",
      defaultBranch: "main",
      private: true,
    });
    expect((await add(999)).status).toBe(404);

    const list = async () => ((await (await api(`/api/projects/${project.id}/repos`, { token })).json()) as { repos: ProjectRepo[] }).repos;
    expect((await list()).map((r) => r.fullName)).toEqual(["acme/app"]);

    expect((await api(`/api/projects/${project.id}/repos/7`, { method: "DELETE", token })).status).toBe(204);
    expect(await list()).toEqual([]);
  });

  it("does not let users add repos from installations they cannot reach", async () => {
    const owner = await signUp();
    const project = await createProject(owner);
    const res = await api(`/api/projects/${project.id}/repos`, {
      method: "POST",
      token: owner,
      body: JSON.stringify({ installationId: 42, repoId: 7 }),
    });
    expect(res.status).toBe(403);

    const stranger = await signUp();
    await connect(stranger);
    const other = await api(`/api/projects/${project.id}/repos`, {
      method: "POST",
      token: stranger,
      body: JSON.stringify({ installationId: 42, repoId: 7 }),
    });
    expect(other.status).toBe(404);
  });

  it("lets thread agents read connected repositories only", async () => {
    const token = await signUp();
    await connect(token);
    const project = await createProject(token);
    await api(`/api/projects/${project.id}/repos`, { method: "POST", token, body: JSON.stringify({ installationId: 42, repoId: 7 }) });

    expect(await listRepoFiles(env, project.id, "acme/app", "")).toBe("src/\nREADME.md (11 bytes)");
    expect(await readRepoFile(env, project.id, "ACME/app", "src/index.ts")).toBe("export const x = 1;\n");
    await expect(readRepoFile(env, project.id, "acme/docs", "README.md")).rejects.toThrow(/not connected/);

    const tokenRequest = fakeGithub.requests.findLast((r) => r.url.endsWith("/access_tokens"));
    expect(tokenRequest?.body).toEqual({ repository_ids: [7], permissions: { contents: "read", metadata: "read" } });
  });

  it("drops repositories when the app is uninstalled", async () => {
    const token = await signUp();
    await connect(token);
    const project = await createProject(token);
    await api(`/api/projects/${project.id}/repos`, { method: "POST", token, body: JSON.stringify({ installationId: 42, repoId: 8 }) });

    const body = JSON.stringify({ action: "deleted", installation: { id: 42 } });
    const unsigned = await api("/api/github/webhook", { method: "POST", body, headers: { "x-github-event": "installation" } });
    expect(unsigned.status).toBe(401);
    const res = await api("/api/github/webhook", {
      method: "POST",
      body,
      headers: { "x-github-event": "installation", "x-hub-signature-256": await signWebhook(body) },
    });
    expect(res.status).toBe(200);
    expect(((await (await api(`/api/projects/${project.id}/repos`, { token })).json()) as { repos: unknown[] }).repos).toEqual([]);
    expect(((await (await api("/api/github", { token })).json()) as GithubStatus).installations).toEqual([]);
  });
});
