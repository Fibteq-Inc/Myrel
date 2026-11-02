import { type ExternalTrust, wrapExternal } from "../agents/external";
import type { ProjectRepoIssues } from "@myrel/protocol";
import { GithubError, type GithubEnv, githubFetch } from "./app";
import { projectRepoToken } from "./store";

/**
 * The thread agent's repo_list_issues and repo_read_issue tools: issues of a connected repository,
 * read with a token of their own (issues: read), never the turn's token, so every issue's text
 * reaches the agent as data (agents/external.ts). On a public repository anyone can open an issue
 * or comment: text from people without a hand in the repository is untrusted and marks the thread.
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

function cut(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}\n[cut at ${max} of ${text.length} characters]` : text;
}

async function issuesToken(env: IssuesEnv, projectId: string, repo: string) {
  try {
    return await projectRepoToken(env, projectId, repo, { issues: "read", metadata: "read" });
  } catch (err) {
    // An installation that was never granted the app's issues permission.
    if (err instanceof GithubError && err.status === 422) {
      throw new Error(`Myrel's GitHub App has no access to ${repo}'s issues. Its owner can grant the Issues permission in the app's installation settings on GitHub.`);
    }
    throw err;
  }
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

/** For people: each connected repository's issues as the Issues tab shows them, without their text. */
export async function projectIssues(env: IssuesEnv, projectId: string, repos: string[], state: ListOpts["state"]): Promise<ProjectRepoIssues[]> {
  return Promise.all(
    repos.map(async (repo): Promise<ProjectRepoIssues> => {
      try {
        const { r, issues } = await fetchRepoIssues(env, projectId, repo, { state, limit: 50 });
        return {
          repo: r.fullName,
          issues: issues.map((i) => ({
            repo: r.fullName,
            number: i.number,
            title: i.title,
            state: i.state === "closed" ? "closed" : "open",
            url: i.html_url,
            author: i.user?.login ?? "ghost",
            member: issueTrust(i.author_association) === "member",
            labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)).filter((l): l is string => !!l),
            comments: i.comments,
            createdAt: i.created_at,
            updatedAt: i.updated_at,
          })),
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
  const trust: ExternalTrust = issues.every((i) => issueTrust(i.author_association) === "member") ? "member" : "untrusted";
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
  const block = (author: User, association: string | undefined, text: string, max: number) => {
    const w = wrapExternal({ source: "github-issue", ref, author: author?.login ?? "ghost", trust: issueTrust(association) }, cut(text, max));
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
