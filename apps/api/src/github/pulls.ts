import { createDb, schema } from "@myrel/db";
import type { PullRequest } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { and, eq } from "drizzle-orm";
import { GithubError, githubFetch, installationToken, type RepoPermissions } from "./app";
import { type PullCredit, hasAttribution, withAttribution } from "./attribution";
import { listProjectRepos, projectRepoToken } from "./store";

const { pullRequests } = schema;

type Row = typeof pullRequests.$inferSelect;
type PullsEnv = Env;

/** What reading a pull request and its CI needs; the app asks for nothing more. */
const READ: RepoPermissions = { pull_requests: "read", checks: "read", statuses: "read", metadata: "read" };
/**
 * Opening a pull request, crediting it and assigning it; issues covers the assignees. GitHub reads
 * the head and base branches when it opens one, so without contents it answers "not all refs are
 * readable".
 */
const WRITE: RepoPermissions = { contents: "read", pull_requests: "write", issues: "write", metadata: "read" };

/** Only a pull request opened this recently is credited when first followed, never an older one a reply mentions. */
const CREDIT_WINDOW_MS = 6 * 60 * 60 * 1000;

type ApiPull = {
  number: number;
  html_url: string;
  title: string;
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
  body?: string | null;
  created_at?: string;
  user?: { login: string };
  head: { sha: string; ref: string };
};
type ApiCheckRun = { name: string; status: string; conclusion: string | null };

/** Check run conclusions that mean the commit is broken. Neutral and skipped ones do not count. */
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

export function toPullRequest(row: Row): PullRequest {
  return {
    repo: row.fullName,
    number: row.number,
    url: row.url,
    threadId: row.threadId,
    title: row.title,
    state: row.state,
    draft: row.draft,
    checks: row.checks,
    review: row.review,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** owner/name and number from a pull request's web address. */
export function parsePullUrl(url: string): { fullName: string; number: number } | null {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/);
  return m ? { fullName: m[1]!, number: Number(m[2]) } : null;
}

export async function listPullRequests(db: D1Database, projectId: string, threadId?: string): Promise<PullRequest[]> {
  const rows = await createDb(db)
    .select()
    .from(pullRequests)
    .where(threadId ? and(eq(pullRequests.projectId, projectId), eq(pullRequests.threadId, threadId)) : eq(pullRequests.projectId, projectId))
    .orderBy(pullRequests.createdAt);
  return rows.map(toPullRequest);
}

/**
 * Remembers a pull request a thread's task opened, so the webhook keeps it
 * current. Only repositories connected to the project are followed. Returns
 * null when the address is not one of those.
 */
export async function trackPullRequest(
  env: PullsEnv,
  projectId: string,
  threadId: string,
  url: string,
  /** Given when the thread opened it: the first time it is followed, it is credited (see creditPull). */
  credit?: PullCredit,
): Promise<PullRequest | null> {
  const parsed = parsePullUrl(url);
  if (!parsed) return null;
  const repo = (await listProjectRepos(env.DB, projectId)).find((r) => r.fullName.toLowerCase() === parsed.fullName.toLowerCase());
  if (!repo) return null;
  const { token } = await installationToken(env, repo.installationId, { repositoryIds: [repo.repoId], permissions: READ });
  const pull = await githubFetch<ApiPull>(token, `/repos/${repo.fullName}/pulls/${parsed.number}`);
  if (credit) {
    const [known] = await createDb(env.DB)
      .select({ number: pullRequests.number })
      .from(pullRequests)
      .where(and(eq(pullRequests.repoId, repo.repoId), eq(pullRequests.number, pull.number)))
      .limit(1);
    const opened = pull.created_at ? Date.parse(pull.created_at) : Date.now();
    const recent = credit.since ? opened >= Date.parse(credit.since) : Date.now() - opened < CREDIT_WINDOW_MS;
    if (!known && recent && pull.state === "open") {
      await creditPull(env, repo, pull, credit).catch((err) => console.warn("crediting pull request failed", pull.html_url, err));
    }
  }
  const checks = await checkState(token, repo.fullName, pull.head.sha);
  const values = {
    repoId: repo.repoId,
    number: pull.number,
    fullName: repo.fullName,
    installationId: repo.installationId,
    projectId,
    threadId,
    url: pull.html_url,
    title: pull.title,
    state: pullState(pull),
    draft: pull.draft ?? false,
    headSha: pull.head.sha,
    headRef: pull.head.ref,
    checks: checks.state,
  };
  const [row] = await createDb(env.DB)
    .insert(pullRequests)
    .values(values)
    .onConflictDoUpdate({ target: [pullRequests.repoId, pullRequests.number], set: { ...values, updatedAt: new Date() } })
    .returning();
  const pr = toPullRequest(row!);
  await broadcast(env, projectId, pr);
  return pr;
}

/**
 * Puts Myrel's block (who asked, a link to the thread) on top of the body when it is missing, then
 * assigns the person and asks them for a review. Every step is best effort: GitHub refuses a review
 * from the pull request's own author, and an assignee who cannot reach the repository.
 */
async function creditPull(env: PullsEnv, repo: { installationId: number; repoId: number; fullName: string }, pull: ApiPull, credit: PullCredit) {
  const { token } = await installationToken(env, repo.installationId, { repositoryIds: [repo.repoId], permissions: WRITE });
  if (!hasAttribution(pull.body)) {
    const body = withAttribution(pull.body, credit);
    if (body !== (pull.body ?? "")) {
      await githubFetch(token, `/repos/${repo.fullName}/pulls/${pull.number}`, { method: "PATCH", body: { body } }).catch((err) =>
        console.warn("pull request body not credited", pull.html_url, err),
      );
    }
  }
  const login = credit.login;
  if (!login) return;
  await githubFetch(token, `/repos/${repo.fullName}/issues/${pull.number}/assignees`, { method: "POST", body: { assignees: [login] } }).catch(
    (err) => console.warn("pull request not assigned", pull.html_url, err),
  );
  if (pull.user?.login.toLowerCase() !== login.toLowerCase()) {
    await githubFetch(token, `/repos/${repo.fullName}/pulls/${pull.number}/requested_reviewers`, {
      method: "POST",
      body: { reviewers: [login] },
    }).catch((err) => console.warn("review not requested", pull.html_url, err));
  }
}

export type OpenPullInput = { repo: string; head: string; base?: string; title: string; body?: string; draft?: boolean };

/**
 * Opens a pull request on a connected repository through Myrel's GitHub App, so the agent needs no
 * GitHub sign-in of its own (a local CLI only pushes the branch). The body starts with Myrel's block,
 * and the pull request is followed like any other. An open one for the same branch is reused.
 */
export async function openPullRequest(
  env: PullsEnv,
  projectId: string,
  threadId: string,
  input: OpenPullInput,
  credit: PullCredit,
): Promise<{ pr: PullRequest; created: boolean }> {
  const { token, repo } = await projectRepoToken(env, projectId, input.repo, WRITE);
  const owner = repo.fullName.split("/")[0]!;
  const head = input.head.includes(":") ? input.head : `${owner}:${input.head}`;
  let url: string;
  let created = true;
  try {
    const pull = await githubFetch<ApiPull>(token, `/repos/${repo.fullName}/pulls`, {
      method: "POST",
      body: {
        title: input.title,
        head: input.head,
        base: input.base || repo.defaultBranch,
        body: withAttribution(input.body, credit),
        draft: input.draft ?? false,
      },
    });
    url = pull.html_url;
  } catch (err) {
    if (!(err instanceof GithubError) || err.status !== 422) throw err;
    // GitHub answers 422 both for a branch that already has an open pull request and for one it
    // does not know (not pushed yet); only the first can be picked up.
    const open = await githubFetch<ApiPull[]>(token, `/repos/${repo.fullName}/pulls?state=open&head=${encodeURIComponent(head)}`);
    if (!open[0]) throw new Error(`GitHub refused the pull request: ${err.message}. Push the branch ${input.head} first, and check that it differs from the base.`);
    url = open[0].html_url;
    created = false;
  }
  const pr = await trackPullRequest(env, projectId, threadId, url, credit);
  if (!pr) throw new Error(`The pull request ${url} was opened but could not be followed.`);
  return { pr, created };
}

/** The combined CI result on a commit: check runs plus legacy commit statuses. */
async function checkState(
  token: string,
  fullName: string,
  sha: string,
): Promise<{ state: Row["checks"]; failed: string[] }> {
  const [runs, status] = await Promise.all([
    githubFetch<{ check_runs: ApiCheckRun[] }>(token, `/repos/${fullName}/commits/${sha}/check-runs?per_page=100`),
    githubFetch<{ state: string; total_count: number; statuses: { context: string; state: string }[] }>(
      token,
      `/repos/${fullName}/commits/${sha}/status`,
    ),
  ]);
  const failed = [
    ...runs.check_runs.filter((r) => r.status === "completed" && FAILED.has(r.conclusion ?? "")).map((r) => r.name),
    ...status.statuses.filter((s) => s.state === "failure" || s.state === "error").map((s) => s.context),
  ];
  const pending = runs.check_runs.some((r) => r.status !== "completed") || status.statuses.some((s) => s.state === "pending");
  const any = runs.check_runs.length > 0 || status.total_count > 0;
  return { state: failed.length ? "failure" : pending ? "pending" : any ? "success" : null, failed };
}

function pullState(pull: Pick<ApiPull, "state" | "merged" | "merged_at">): Row["state"] {
  return pull.merged || pull.merged_at ? "merged" : pull.state;
}

// --- Webhook ---

type Sender = { login: string; type?: string };
export type PullWebhookPayload = {
  action?: string;
  sender?: Sender;
  repository?: { id: number; full_name: string };
  installation?: { id: number };
  pull_request?: ApiPull;
  check_run?: { head_sha: string; pull_requests?: { number: number }[] };
  review?: { state: string; body: string | null; user: Sender; html_url: string; author_association?: string };
  comment?: { body: string; user: Sender; html_url: string; path?: string; author_association?: string };
  issue?: { number: number; pull_request?: unknown };
};

/**
 * Pull request, CI, review and comment events for pull requests a thread
 * opened: updates the stored state, shows it live, and wakes the thread's
 * agent when something needs it (CI failed, changes requested, a person
 * commented, merged or closed). Events about other pull requests are ignored.
 */
export async function handlePullEvent(env: PullsEnv, event: string, payload: PullWebhookPayload): Promise<void> {
  const repoId = payload.repository?.id;
  if (!repoId) return;
  const d = createDb(env.DB);
  const find = async (number: number) =>
    (await d.select().from(pullRequests).where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.number, number))).limit(1))[0];

  if (event === "pull_request" && payload.pull_request) {
    const pull = payload.pull_request;
    const row = await find(pull.number);
    if (!row) return;
    const moved = pull.head.sha !== row.headSha;
    const next = await save(env, row, {
      title: pull.title,
      state: pullState(pull),
      draft: pull.draft ?? false,
      headSha: pull.head.sha,
      headRef: pull.head.ref,
      // New commits start a new CI run; an earlier review may no longer apply either.
      ...(moved ? { checks: row.checks === null ? null : ("pending" as const) } : {}),
    });
    if (next.state !== row.state && next.state !== "open") {
      const merged = next.state === "merged";
      await wake(env, row, merged ? "was merged." : "was closed without merging.", { pr: `${row.fullName}#${row.number}`, merged });
    }
    return;
  }

  if (event === "check_run" && payload.check_run && payload.action === "completed") {
    const sha = payload.check_run.head_sha;
    const rows = await d.select().from(pullRequests).where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.headSha, sha)));
    for (const row of rows) {
      const { token } = await installationToken(env, row.installationId, { repositoryIds: [row.repoId], permissions: READ });
      const checks = await checkState(token, row.fullName, sha);
      if (checks.state === row.checks) continue;
      await save(env, row, { checks: checks.state });
      if (checks.state === "failure") await wake(env, row, `has failing CI on its latest commit: ${checks.failed.join(", ")}.`);
    }
    return;
  }

  if (event === "pull_request_review" && payload.review && payload.pull_request) {
    const row = await find(payload.pull_request.number);
    if (!row || ignored(payload.sender)) return;
    const state = payload.review.state.toLowerCase();
    if (payload.action === "dismissed") {
      await save(env, row, { review: null });
    } else if (!trusted(payload.review.author_association)) {
      // On a public repository anyone can review, even ask for changes: their words do not reach the agent.
      return;
    } else if (payload.action === "submitted" && (state === "approved" || state === "changes_requested")) {
      await save(env, row, { review: state });
      if (state === "changes_requested") {
        await wake(env, row, `got a review from ${payload.review.user.login} asking for changes:\n${quote(payload.review.body)}`);
      }
    } else if (payload.action === "submitted" && payload.review.body?.trim()) {
      await wake(env, row, `got a review comment from ${payload.review.user.login}:\n${quote(payload.review.body)}`);
    }
    return;
  }

  const number = event === "issue_comment" && payload.issue?.pull_request ? payload.issue.number : payload.pull_request?.number;
  if ((event === "issue_comment" || event === "pull_request_review_comment") && payload.comment && number) {
    if (payload.action !== "created" || ignored(payload.sender) || !trusted(payload.comment.author_association)) return;
    const row = await find(number);
    if (!row) return;
    const where = payload.comment.path ? ` on ${payload.comment.path}` : "";
    await wake(env, row, `got a comment from ${payload.comment.user.login}${where}:\n${quote(payload.comment.body)}`);
  }
}

/** Our own app's activity and other bots' chatter do not wake anyone (GitHub marks both as bots). */
function ignored(sender?: Sender) {
  return !sender || sender.type === "Bot";
}

/**
 * Only people with a hand in the repository wake the agent with their words; on a public
 * repository anyone can comment, and their text should not steer the agent or spend its budget.
 */
function trusted(association?: string) {
  return association === "OWNER" || association === "MEMBER" || association === "COLLABORATOR";
}

function quote(text: string | null) {
  const body = (text ?? "").trim().slice(0, 2000);
  return body ? body.split("\n").map((l) => `> ${l}`).join("\n") : "> (no text)";
}

async function save(env: PullsEnv, row: Row, set: Partial<Row>): Promise<Row> {
  const [next] = await createDb(env.DB)
    .update(pullRequests)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(pullRequests.repoId, row.repoId), eq(pullRequests.number, row.number)))
    .returning();
  await broadcast(env, next!.projectId, toPullRequest(next!));
  return next!;
}

async function broadcast(env: PullsEnv, projectId: string, pr: PullRequest) {
  const project = await getAgentByName(env.PROJECT_AGENT, projectId);
  await project.broadcastPullRequest(pr);
}

async function wake(env: PullsEnv, row: Row, what: string, settled?: { pr: string; merged: boolean }) {
  const agent = await getAgentByName(env.THREAD_AGENT, row.threadId);
  const event = `Pull request ${row.fullName}#${row.number} "${row.title}" (${row.url}, branch ${row.headRef}) ${what}`;
  await agent.wake({ kind: "github", event, ...(settled && { settled }) });
}

