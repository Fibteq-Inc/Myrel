import { createDb, schema } from "@myrel/db";
import type { GithubRepo, GithubStatus } from "@myrel/protocol";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import {
  exchangeCode,
  type GithubApiRepo,
  githubConfigured,
  installationRepos,
  userInstallations,
} from "../github/app";
import { handlePullEvent } from "../github/pulls";
import { safeReturnTo, signState, verifyState, verifyWebhook } from "../github/state";
import { listUserInstallations, syncUserInstallations } from "../github/store";
import { type AppEnv, requireUser } from "../middleware";

const { githubInstallations, projectRepos } = schema;

/**
 * GitHub App integration. Connecting is a browser round trip:
 * `/connect` (signed in) → GitHub (install the app, or just sign in) →
 * `/callback`, which asks GitHub which installations this person can reach
 * and remembers them. Repositories are then picked per project
 * (routes/projects.ts). `/webhook` keeps things in sync when the app is
 * uninstalled or loses repositories.
 */
export const githubRoutes = new Hono<AppEnv>()
  .post("/webhook", async (c) => {
    if (!c.env.GITHUB_WEBHOOK_SECRET) return c.json({ error: "webhook_not_configured" }, 503);
    const body = await c.req.text();
    if (!(await verifyWebhook(c.env.GITHUB_WEBHOOK_SECRET, body, c.req.header("x-hub-signature-256")))) {
      return c.json({ error: "bad_signature" }, 401);
    }
    const event = c.req.header("x-github-event") ?? "";
    const payload = JSON.parse(body);
    await handleWebhook(c.env.DB, event, payload);
    // A GitHub hiccup while reading CI must not fail the delivery; the next event catches up.
    await handlePullEvent(c.env, event, payload).catch((err) => console.error("pull request event failed", event, err));
    return c.json({ ok: true });
  })
  .use(requireUser)
  .get("/", async (c) => {
    const configured = githubConfigured(c.env);
    return c.json({
      configured,
      installUrl: configured ? `https://github.com/apps/${c.env.GITHUB_APP_SLUG}/installations/new` : null,
      installations: configured ? await listUserInstallations(c.env.DB, c.get("user").id) : [],
    } satisfies GithubStatus);
  })
  /**
   * Starts the round trip. A browser navigation (not fetch), because the
   * callback has to see the same signed-in session: `mode=install` opens the
   * app's install page, `mode=authorize` only signs in to GitHub to pick up
   * installations someone else (an org admin) already made.
   */
  .get("/connect", async (c) => {
    if (!githubConfigured(c.env)) return c.json({ error: "github_not_configured" }, 503);
    const state = await signState(c.env.BETTER_AUTH_SECRET, {
      userId: c.get("user").id,
      returnTo: safeReturnTo(c.req.query("returnTo")),
    });
    const url =
      c.req.query("mode") === "authorize"
        ? `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(c.env.GITHUB_CLIENT_ID!)}&state=${encodeURIComponent(state)}`
        : `https://github.com/apps/${c.env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`;
    return c.redirect(url);
  })
  .get("/callback", async (c) => {
    const state = await verifyState(c.env.BETTER_AUTH_SECRET, c.req.query("state") ?? "");
    // The state must belong to whoever is signed in here, so nobody can attach
    // their GitHub to someone else's Myrel account (or the other way round).
    if (!state || state.userId !== c.get("user").id) return c.redirect("/?github=invalid_state");
    const back = (result: string) => c.redirect(`${state.returnTo}${state.returnTo.includes("?") ? "&" : "?"}github=${result}`);

    const code = c.req.query("code");
    // Installing without "Request user authorization during installation" comes back without a code.
    if (!code) return back("no_code");
    try {
      const token = await exchangeCode(c.env, code);
      await syncUserInstallations(c.env.DB, c.get("user").id, await userInstallations(token));
      return back("connected");
    } catch (err) {
      console.error("github callback failed", err);
      return back("error");
    }
  })
  /** Every repository the user's installations can reach, for the project repo picker. */
  .get("/repos", async (c) => {
    if (!githubConfigured(c.env)) return c.json({ repos: [] });
    const installs = await listUserInstallations(c.env.DB, c.get("user").id);
    const lists = await Promise.all(
      installs.map(async (i) =>
        (await installationRepos(c.env, i.id).catch((err) => {
          console.error("listing installation repos failed", i.id, err);
          return [] as GithubApiRepo[];
        })).map((r): GithubRepo => ({
          id: r.id,
          installationId: i.id,
          fullName: r.full_name,
          defaultBranch: r.default_branch,
          private: r.private,
          description: r.description,
        })),
      ),
    );
    return c.json({ repos: lists.flat().sort((a, b) => a.fullName.localeCompare(b.fullName)) });
  });

type WebhookRepo = { id: number; full_name: string; default_branch?: string };
type WebhookPayload = {
  action?: string;
  installation?: { id: number; account?: { login: string; avatar_url?: string } };
  repositories_removed?: WebhookRepo[];
  repository?: WebhookRepo;
};

/** Installation and repository bookkeeping. Pull request events are handled in github/pulls.ts. */
export async function handleWebhook(db: D1Database, event: string, payload: WebhookPayload) {
  const d = createDb(db);
  const installationId = payload.installation?.id;
  if (event === "installation" && installationId) {
    if (payload.action === "deleted") {
      await d.batch([
        d.delete(projectRepos).where(eq(projectRepos.installationId, installationId)),
        d.delete(githubInstallations).where(eq(githubInstallations.id, installationId)),
      ]);
    }
  } else if (event === "installation_repositories" && installationId && payload.action === "removed") {
    const ids = (payload.repositories_removed ?? []).map((r) => r.id);
    if (ids.length) {
      await d
        .delete(projectRepos)
        .where(and(eq(projectRepos.installationId, installationId), inArray(projectRepos.repoId, ids)));
    }
  } else if (event === "repository" && payload.repository) {
    const repo = payload.repository;
    if (payload.action === "deleted") {
      await d.delete(projectRepos).where(eq(projectRepos.repoId, repo.id));
    } else if (payload.action === "renamed" || payload.action === "transferred" || payload.action === "edited") {
      await d
        .update(projectRepos)
        .set({ fullName: repo.full_name, ...(repo.default_branch ? { defaultBranch: repo.default_branch } : {}) })
        .where(eq(projectRepos.repoId, repo.id));
    }
  }
}
