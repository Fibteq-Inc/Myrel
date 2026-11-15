import { type ExternalTrust, revealHidden, wrapExternal } from "../agents/external";
import type { ProjectIssue, ProjectIssueDetail, ProjectRepoIssues } from "@myrel/protocol";
import { GithubError, type GithubEnv, appSlug, githubFetch, installationToken } from "./app";
import { type PullCredit, creditLine } from "./attribution";
import { findUserRepo, listProjectRepos, projectRepoToken } from "./store";

/**
 * The thread agent's repo_list_issues and repo_read_issue tools: issues of a connected repository,
 * read with a token of their own (issues: read), never the turn's token, so every issue's text
 * reaches the agent as data (agents/external.ts). On a public repository anyone can open an issue
 * or comment: text from people without a hand in the repository is untrusted and marks the thread.
 *
 * The tools that write (open_issues, comment_on_issue, update_issue, link_pull_request) have tokens of
 * their own too, made for that one call on the server, so the turn's token stays without issues and
 * gh cannot go around the tools or their card.
 */

type IssuesEnv = GithubEnv & { DB: D1Database };

type User = { login: string; type?: string } | null;
type ApiIssue = {
  number: number;
  title: string;
  state: string;
  body: string | null;
  user: User;
  author_association?: string;
  labels: ({ name?: string } | string)[];
  comments: number;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
};
type ApiComment = { user: User; author_association?: string; body: string | null; created_at: string };

/** Longest issue body and comment handed to the model. */
const MAX_BODY_CHARS = 8000;
const MAX_COMMENT_CHARS = 2000;
const COMMENTS_PER_PAGE = 30;

export type IssueRead = { text: string; external: string | null };

/** People with a hand in the repository; anyone else's words are untrusted. */
export function issueTrust(association?: string): ExternalTrust {
  return association === "OWNER" || association === "MEMBER" || association === "COLLABORATOR" ? "member" : "untrusted";
}

/**
 * How far to trust an author, knowing Myrel's own app: GitHub calls an app "NONE", so without this
 * every issue open_issues opened would mark each thread that lists them and show as an outsider's.
 */
async function authorTrust(env: IssuesEnv) {
  const own = await appSlug(env).then((slug) => `${slug}[bot]`.toLowerCase()).catch(() => null);
  return (author: User, association?: string): ExternalTrust => (own && author?.login.toLowerCase() === own ? "member" : issueTrust(association));
}

function cut(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}\n[cut at ${max} of ${text.length} characters]` : text;
}

/** A token for issues, saying so when the installation was never granted the app's issues permission. */
async function withIssuesPermission<T>(repo: string, token: () => Promise<T>): Promise<T> {
  try {
    return await token();
  } catch (err) {
    if (err instanceof GithubError && err.status === 422) {
      throw new Error(`Myrel's GitHub App has no access to ${repo}'s issues. Its owner can grant the Issues permission in the app's installation settings on GitHub.`);
    }
    throw err;
  }
}

async function issuesToken(env: IssuesEnv, projectId: string, repo: string, access: "read" | "write" = "read") {
  return withIssuesPermission(repo, () => projectRepoToken(env, projectId, repo, { issues: access, metadata: "read" }));
}

export async function isConnectedRepo(env: IssuesEnv, projectId: string, repo: string): Promise<boolean> {
  const name = repo.trim().toLowerCase();
  return (await listProjectRepos(env.DB, projectId)).some((r) => r.fullName.toLowerCase() === name);
}

/** Why a repository outside the project cannot be written to for a person (see findUserRepo). */
export class UnconnectedRepoError extends Error {
  constructor(
    readonly repo: string,
    readonly reason: "github_reauth" | "not_installed",
  ) {
    super(
      reason === "github_reauth"
        ? `Nothing was done: ${repo} is not connected to this project and the person's GitHub sign-in in Myrel is missing or too old to check their access to it. They sign in to GitHub again, then ask again.`
        : `Nothing was done: ${repo} is not connected to this project, and it cannot be reached for this person: the name may be wrong, Myrel's GitHub App may not be installed on it, or they cannot push to it on GitHub. Check the name, or tell the person what is needed.`,
    );
  }
}

/**
 * Where new issues go. A connected repository as ever; any other only for `approver`, the person who
 * allowed it on a card, as far as their own GitHub access reaches. The token is limited to that
 * repository and its issues, made here on the server, and connects nothing to the project.
 */
async function newIssueTarget(env: IssuesEnv, projectId: string, repo: string, approver: string | null) {
  if (await isConnectedRepo(env, projectId, repo)) return issuesToken(env, projectId, repo, "write");
  if (!approver) throw new Error(`Nothing was done: ${repo} is not connected to this project, and writing there needs a person's OK on a card.`);
  const found = await findUserRepo(env, approver, repo);
  if (!found.ok) throw new UnconnectedRepoError(repo, found.reason);
  const { token } = await withIssuesPermission(repo, () =>
    installationToken(env, found.installationId, { repositoryIds: [found.repo.id], permissions: { issues: "write", metadata: "read" } }),
  );
  return { token, repo: { fullName: found.repo.full_name } };
}

type ListOpts = { state?: "open" | "closed" | "all"; labels?: string; limit?: number };

/** Open (or closed, or all) issues, newest activity first, without pull requests. */
async function fetchRepoIssues(env: IssuesEnv, projectId: string, repo: string, opts: ListOpts) {
  const { token, repo: r } = await issuesToken(env, projectId, repo);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const query = new URLSearchParams({ state: opts.state ?? "open", sort: "updated", per_page: String(limit) });
  if (opts.labels) query.set("labels", opts.labels);
  const issues = (await githubFetch<ApiIssue[]>(token, `/repos/${r.fullName}/issues?${query}`)).filter((i) => !i.pull_request);
  return { r, issues };
}

function toProjectIssue(repo: string, i: ApiIssue, trust: (author: User, association?: string) => ExternalTrust): ProjectIssue {
  return {
    repo,
    number: i.number,
    title: i.title,
    state: i.state === "closed" ? "closed" : "open",
    url: i.html_url,
    author: i.user?.login ?? "ghost",
    member: trust(i.user, i.author_association) === "member",
    labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)).filter((l): l is string => !!l),
    comments: i.comments,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
  };
}

/**
 * For people: one issue as the Issues tab opens it, with a page of comments. What GitHub hides from
 * its readers is shown here too, so someone reading it sees what an agent would. Null when it is not
 * an issue of that repository: a pull request, or one that does not exist.
 */
export async function projectIssue(env: IssuesEnv, projectId: string, repo: string, number: number, page = 1): Promise<ProjectIssueDetail | null> {
  const { token, repo: r } = await issuesToken(env, projectId, repo);
  const issue = await githubFetch<ApiIssue>(token, `/repos/${r.fullName}/issues/${number}`).catch((err) => {
    if (err instanceof GithubError && (err.status === 404 || err.status === 410)) return null;
    throw err;
  });
  if (!issue || issue.pull_request) return null;
  const comments = issue.comments
    ? await githubFetch<ApiComment[]>(token, `/repos/${r.fullName}/issues/${number}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`)
    : [];
  const trust = await authorTrust(env);
  return {
    ...toProjectIssue(r.fullName, issue, trust),
    body: revealHidden(issue.body ?? ""),
    commentList: comments.map((c) => ({
      author: c.user?.login ?? "ghost",
      member: trust(c.user, c.author_association) === "member",
      body: revealHidden(c.body ?? ""),
      createdAt: c.created_at,
    })),
    moreComments: (page - 1) * COMMENTS_PER_PAGE + comments.length < issue.comments,
  };
}

/** For people: each connected repository's issues as the Issues tab shows them, without their text. */
export async function projectIssues(env: IssuesEnv, projectId: string, repos: string[], state: ListOpts["state"]): Promise<ProjectRepoIssues[]> {
  const trust = await authorTrust(env);
  return Promise.all(
    repos.map(async (repo): Promise<ProjectRepoIssues> => {
      try {
        const { r, issues } = await fetchRepoIssues(env, projectId, repo, { state, limit: 50 });
        return {
          repo: r.fullName,
          issues: issues.map((i) => toProjectIssue(r.fullName, i, trust)),
        };
      } catch (err) {
        const noAccess = err instanceof Error && err.message.includes("has no access to");
        if (!noAccess) console.warn("listing issues failed", repo, err);
        return { repo, issues: [], error: noAccess ? "no_access" : "failed" };
      }
    }),
  );
}

/** For the agent: the list as data (see agents/external.ts). */
export async function listRepoIssues(env: IssuesEnv, projectId: string, repo: string, opts: ListOpts = {}): Promise<IssueRead> {
  const { r, issues } = await fetchRepoIssues(env, projectId, repo, opts);
  if (!issues.length) return { text: `No ${opts.state ?? "open"} issues in ${r.fullName}${opts.labels ? ` with labels ${opts.labels}` : ""}.`, external: null };
  const lines = issues.map((i) => {
    const labels = i.labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
    return `#${i.number} [${i.state}] ${i.title} · by ${i.user?.login ?? "ghost"} (${i.author_association ?? "NONE"}) · ${i.comments} comments · updated ${i.updated_at}${labels.length ? ` · labels: ${labels.join(", ")}` : ""}`;
  });
  // Titles are their authors' words: the list is as trusted as its least trusted author.
  const authors = await authorTrust(env);
  const trust: ExternalTrust = issues.every((i) => authors(i.user, i.author_association) === "member") ? "member" : "untrusted";
  const wrapped = wrapExternal({ source: "github-issues", ref: r.fullName, trust }, lines.join("\n"));
  return { text: `${wrapped.text}\nRead one with repo_read_issue.`, external: wrapped.taints ? `github-issues:${r.fullName}` : null };
}

/** One issue: its body and a page of comments, each in its own block with its author's trust. */
export async function readRepoIssue(env: IssuesEnv, projectId: string, repo: string, number: number, page = 1): Promise<IssueRead> {
  const { token, repo: r } = await issuesToken(env, projectId, repo);
  const issue = await githubFetch<ApiIssue>(token, `/repos/${r.fullName}/issues/${number}`);
  if (issue.pull_request) return { text: `${r.fullName}#${number} is a pull request, not an issue.`, external: null };
  const comments = issue.comments
    ? await githubFetch<ApiComment[]>(token, `/repos/${r.fullName}/issues/${number}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`)
    : [];
  const ref = `${r.fullName}#${number}`;
  let taints = false;
  const authors = await authorTrust(env);
  const block = (author: User, association: string | undefined, text: string, max: number) => {
    const w = wrapExternal({ source: "github-issue", ref, author: author?.login ?? "ghost", trust: authors(author, association) }, cut(text, max));
    taints ||= w.taints;
    return w.text;
  };
  const labels = issue.labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
  const head = [
    `${ref} [${issue.state}] (${issue.html_url})`,
    `Opened by ${issue.user?.login ?? "ghost"} (${issue.author_association ?? "NONE"}) on ${issue.created_at}, updated ${issue.updated_at}${labels.length ? `, labels: ${labels.join(", ")}` : ""}.`,
    "Title and description:",
    block(issue.user, issue.author_association, `${issue.title}\n\n${issue.body ?? ""}`.trim(), MAX_BODY_CHARS),
  ];
  const shown = comments.map(
    (c) => `Comment by ${c.user?.login ?? "ghost"} (${c.author_association ?? "NONE"}) on ${c.created_at}:\n${block(c.user, c.author_association, c.body ?? "", MAX_COMMENT_CHARS)}`,
  );
  const from = (page - 1) * COMMENTS_PER_PAGE;
  const more = from + comments.length < issue.comments ? `\n[comments ${from + 1}-${from + comments.length} of ${issue.comments}; pass page ${page + 1} for more]` : "";
  const text = [...head, ...(shown.length ? [`${issue.comments} comments:`, ...shown] : [issue.comments ? `No comments on page ${page}.` : "No comments."])].join("\n\n") + more;
  return { text, external: taints ? `github-issue:${ref}` : null };
}

export type NewIssue = { title: string; body?: string; labels?: string[] };

/** Longest description one issue and one call may carry: a person reads all of it on the card. */
export const MAX_NEW_ISSUE_BODY = 8000;
const MAX_NEW_ISSUES_TOTAL = 30_000;

const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abeprs]-[A-Za-z0-9-]{10,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
const MENTION = /(?:^|[^\w`/.-])@[a-z0-9][a-z0-9-]*/im;

/**
 * Refuses what must not reach GitHub, before any card: an issue can be read by everyone who sees the
 * repository and Myrel cannot delete it, and an @mention sends GitHub's notification to that person.
 * The message never repeats the secret.
 */
export function checkNewIssues(issues: NewIssue[]): void {
  const total = issues.reduce((sum, i) => sum + i.title.length + (i.body?.length ?? 0), 0);
  if (total > MAX_NEW_ISSUES_TOTAL) throw new Error(`These issues are too long together (${total} characters, at most ${MAX_NEW_ISSUES_TOTAL}). Shorten them or open them in two calls.`);
  for (const { title, body } of issues) checkIssueText(`${title}\n${body ?? ""}`, `"${title.replace(SECRET, "[secret]")}"`);
}

function checkIssueText(text: string, what: string): void {
  if (SECRET.test(text)) throw new Error(`Nothing was done: ${what} contains what looks like a token or private key. Take it out and call again.`);
  if (MENTION.test(text.replace(CODE, " "))) throw new Error(`Nothing was done: ${what} has an @mention, which would notify that person on GitHub. Write the name without @, or in backticks if it is code, and call again.`);
}

/**
 * Opens issues through Myrel's GitHub App, on a connected repository or, with `approver`, on one the
 * person who allowed it reaches (newIssueTarget), each crediting the person and assigned to them
 * when they have a GitHub login. `opened` holds what the thread already opened, by
 * repository and title, so a turn that repeats itself after a restart does not open them twice. Stops
 * at the first failure and says which were not opened; throws when none was. One line per issue.
 */
export async function openRepoIssues(
  env: IssuesEnv,
  projectId: string,
  repo: string,
  issues: NewIssue[],
  credit: PullCredit,
  opened: { get(key: string): string | undefined; add(key: string, url: string): void },
  approver: string | null = null,
): Promise<string> {
  checkNewIssues(issues);
  const { token, repo: r } = await newIssueTarget(env, projectId, repo, approver);
  const keyOf = (i: NewIssue) => `${r.fullName}\n${i.title.trim()}`.toLowerCase();
  // Only labels the repository has: GitHub would make up new ones. Skipped when listing them fails.
  const wanted = issues.some((i) => i.labels?.length && !opened.get(keyOf(i)));
  const known = wanted
    ? await githubFetch<{ name: string }[]>(token, `/repos/${r.fullName}/labels?per_page=100`).catch((err) => (console.warn("listing labels failed", r.fullName, err), []))
    : [];
  const byName = new Map(known.map((l) => [l.name.toLowerCase(), l.name]));
  const credited = creditLine(credit);
  const lines: string[] = [];
  let done = 0;
  for (const [index, issue] of issues.entries()) {
    const key = keyOf(issue);
    const already = opened.get(key);
    if (already) {
      lines.push(`${already} · ${issue.title} (this thread already opened it)`);
      done++;
      continue;
    }
    const labels = (issue.labels ?? []).map((l) => byName.get(l.toLowerCase())).filter((l): l is string => !!l);
    const dropped = (issue.labels ?? []).filter((l) => !byName.has(l.toLowerCase()));
    try {
      const made = await githubFetch<{ number: number; html_url: string }>(token, `/repos/${r.fullName}/issues`, {
        method: "POST",
        body: { title: issue.title, body: [credited, issue.body?.trim()].filter(Boolean).join("\n\n"), ...(labels.length && { labels }) },
      });
      opened.add(key, made.html_url);
      done++;
      lines.push(`${made.html_url} · ${issue.title}${dropped.length ? ` (no such label: ${dropped.join(", ")})` : ""}`);
      if (credit.login) {
        await githubFetch(token, `/repos/${r.fullName}/issues/${made.number}/assignees`, { method: "POST", body: { assignees: [credit.login] } }).catch((err) =>
          console.warn("issue not assigned", made.html_url, err),
        );
      }
    } catch (err) {
      const why = err instanceof GithubError && err.status === 410 ? `issues are turned off on ${r.fullName}` : err instanceof Error ? err.message : String(err);
      if (!done) throw new Error(`No issue was opened: ${why}`);
      lines.push(`Not opened: ${issues.slice(index).map((i) => `"${i.title}"`).join(", ")} (${why})`);
      break;
    }
  }
  return lines.join("\n");
}

export type IssueComment = { repo: string; number: number; body: string };
export type IssueUpdate = {
  repo: string;
  number: number;
  title?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  state?: "open" | "closed";
  state_reason?: "completed" | "not_planned";
  /** Posted first, so closing with a reason is one call and, when a person is asked, one card. */
  comment?: string;
};
export type PullLink = { repo: string; pull_number: number; issue_number: number; closes: boolean };

const CLOSE_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

/** An issue to write on: a pull request's number is refused, since this tool would act on the pull request. */
async function targetIssue(token: string, fullName: string, number: number) {
  const issue = await githubFetch<ApiIssue>(token, `/repos/${fullName}/issues/${number}`).catch((err) => {
    if (err instanceof GithubError && err.status === 404) throw new Error(`${fullName} has no issue #${number}.`);
    if (err instanceof GithubError && err.status === 410) throw new Error(`${fullName}#${number} was deleted, or issues are turned off.`);
    throw err;
  });
  if (issue.pull_request) throw new Error(`${fullName}#${number} is a pull request, not an issue.`);
  return issue;
}

type PullTarget = { number: number; html_url: string; state: string; merged?: boolean; body?: string | null; user?: User; author_association?: string; base?: { ref: string } };

/**
 * Checks a write before it can reach a card: its text, and that its target is an issue. True when a
 * person should allow it whatever else holds, because it changes what someone outside the repository
 * wrote (their issue's text or state, their pull request's description). A comment changes nothing of theirs.
 */
export async function checkIssueWrite(env: IssuesEnv, projectId: string, tool: "comment_on_issue" | "update_issue" | "link_pull_request", input: IssueComment | IssueUpdate | PullLink): Promise<boolean> {
  const { token, repo: r } = await issuesToken(env, projectId, input.repo);
  const trust = await authorTrust(env);
  if (tool === "comment_on_issue") {
    const { number, body } = input as IssueComment;
    checkIssueText(body, "the comment");
    await targetIssue(token, r.fullName, number);
    return false;
  }
  if (tool === "update_issue") {
    const { number, title, body, comment, labels, assignees, state } = input as IssueUpdate;
    if (title === undefined && body === undefined && !labels && !assignees && !state && !comment) throw new Error("Nothing to change: give at least one of title, body, labels, assignees, state or comment.");
    checkIssueText([title, body, comment].filter(Boolean).join("\n"), `the change to #${number}`);
    const issue = await targetIssue(token, r.fullName, number);
    return trust(issue.user, issue.author_association) !== "member";
  }
  const { pull_number, issue_number } = input as PullLink;
  await targetIssue(token, r.fullName, issue_number);
  const { token: pullToken } = await projectRepoToken(env, projectId, r.fullName, { pull_requests: "read", metadata: "read" });
  const pull = await githubFetch<PullTarget>(pullToken, `/repos/${r.fullName}/pulls/${pull_number}`).catch((err) => {
    if (err instanceof GithubError && err.status === 404) throw new Error(`${r.fullName} has no pull request #${pull_number}.`);
    throw err;
  });
  return trust(pull.user ?? null, pull.author_association) !== "member";
}

/** Comments on an issue, crediting the person. `opened` keeps a turn repeating itself from saying it twice. */
export async function commentOnIssue(env: IssuesEnv, projectId: string, input: IssueComment, credit: PullCredit, opened: { get(key: string): string | undefined; add(key: string, url: string): void }): Promise<string> {
  checkIssueText(input.body, "the comment");
  const { token, repo: r } = await issuesToken(env, projectId, input.repo, "write");
  await targetIssue(token, r.fullName, input.number);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.body));
  const key = `comment\n${r.fullName}#${input.number}\n${btoa(String.fromCharCode(...new Uint8Array(digest)))}`.toLowerCase();
  const already = opened.get(key);
  if (already) return `${already} · this thread already wrote this comment`;
  const made = await githubFetch<{ html_url: string }>(token, `/repos/${r.fullName}/issues/${input.number}/comments`, {
    method: "POST",
    body: { body: [creditLine(credit), input.body.trim()].filter(Boolean).join("\n\n") },
  });
  opened.add(key, made.html_url);
  return `${made.html_url} · commented on #${input.number}`;
}

/** Changes an issue's text, labels, assignees or state, after posting `comment`. One line says what happened. */
export async function updateIssue(env: IssuesEnv, projectId: string, input: IssueUpdate, credit: PullCredit): Promise<string> {
  const { repo, number, title, body, labels, assignees, state, state_reason, comment } = input;
  checkIssueText([title, body, comment].filter(Boolean).join("\n"), `the change to #${number}`);
  const { token, repo: r } = await issuesToken(env, projectId, repo, "write");
  const issue = await targetIssue(token, r.fullName, number);
  const patch: Record<string, unknown> = {};
  const notes: string[] = [];
  if (title !== undefined) patch.title = title;
  // A new description keeps the line saying who asked for the issue.
  if (body !== undefined) patch.body = [issue.body?.match(/^_(?:Requested by|Opened by) [^\n]*_$/m)?.[0], body.trim()].filter(Boolean).join("\n\n");
  if (assignees) patch.assignees = assignees;
  if (state) patch.state = state;
  if (state === "closed" && state_reason) patch.state_reason = state_reason;
  if (labels) {
    const known = await githubFetch<{ name: string }[]>(token, `/repos/${r.fullName}/labels?per_page=100`);
    const byName = new Map(known.map((l) => [l.name.toLowerCase(), l.name]));
    patch.labels = labels.map((l) => byName.get(l.toLowerCase())).filter(Boolean);
    const dropped = labels.filter((l) => !byName.has(l.toLowerCase()));
    if (dropped.length) notes.push(`no such label: ${dropped.join(", ")}`);
  }
  if (comment) {
    await githubFetch(token, `/repos/${r.fullName}/issues/${number}/comments`, { method: "POST", body: { body: [creditLine(credit), comment.trim()].filter(Boolean).join("\n\n") } });
    notes.push("comment posted");
  }
  if (Object.keys(patch).length) await githubFetch(token, `/repos/${r.fullName}/issues/${number}`, { method: "PATCH", body: patch });
  const did = [state === "closed" ? "closed" : state === "open" ? "reopened" : "", ...Object.keys(patch).filter((k) => k !== "state" && k !== "state_reason"), ...notes].filter(Boolean);
  return `${issue.html_url} · ${did.join(", ")}`;
}

/**
 * Links a pull request to an issue the one way GitHub offers: a line in the pull request's description.
 * "Closes #n" closes the issue when it merges into the default branch; "Refs #n" only links them.
 */
export async function linkPullRequest(env: IssuesEnv, projectId: string, input: PullLink): Promise<string> {
  const { token, repo: r } = await projectRepoToken(env, projectId, input.repo, { pull_requests: "write", metadata: "read" });
  const pull = await githubFetch<PullTarget>(token, `/repos/${r.fullName}/pulls/${input.pull_number}`);
  if (pull.merged || pull.state !== "open") throw new Error(`${r.fullName}#${input.pull_number} is not open any more, so a link in its description would not close anything. Comment on the issue instead.`);
  const body = pull.body ?? "";
  const line = `${input.closes ? "Closes" : "Refs"} #${input.issue_number}`;
  const linked = [...body.matchAll(CLOSE_KEYWORD)].some((m) => Number(m[1]) === input.issue_number) || (!input.closes && body.includes(line));
  if (!linked) await githubFetch(token, `/repos/${r.fullName}/pulls/${input.pull_number}`, { method: "PATCH", body: { body: body.trim() ? `${body.trim()}\n\n${line}` : line } });
  const note = input.closes ? `merging it into ${r.fullName}'s default branch closes #${input.issue_number}` : `it refers to #${input.issue_number}`;
  return `${pull.html_url} · ${linked ? "already linked" : "linked"}: ${note}`;
}
