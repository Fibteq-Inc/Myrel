/**
 * A tiny in-memory GitHub for tests: one installation (42, org "acme") that
 * covers repos 7 (acme/app) and 8 (acme/docs). Requests are recorded so tests
 * can check what Myrel asked for.
 */
/** An installation token in GitHub's stateless format (ghs_<app id>_<JWT>, about 520 characters). */
export const INSTALLATION_TOKEN = `ghs_1234567_eyJhbGciOiJSUzI1NiJ9.${"eyJpbnN0YWxsYXRpb24iOjF9".repeat(18)}.${"c2lnbmF0dXJl".repeat(5)}`;

/** The token of the second installation, to tell them apart. */
export const OTHER_INSTALLATION_TOKEN = `${INSTALLATION_TOKEN}.other`;

export const fakeGithub = {
  installations: [{ id: 42, account: { login: "acme", type: "Organization", avatar_url: "https://avatars.test/acme" } }],
  repos: [
    { id: 7, full_name: "acme/app", default_branch: "main", private: true, description: "The app" },
    { id: 8, full_name: "acme/docs", default_branch: "trunk", private: false, description: null },
  ],
  files: { "acme/app": { "README.md": "# Acme app\n", "src/index.ts": "export const x = 1;\n" } } as Record<
    string,
    Record<string, string>
  >,
  /** Pull requests by "owner/name#number", in GitHub's REST shape. */
  pulls: {} as Record<string, unknown>,
  /** A pull request's changed files by "owner/name#number", in GitHub's REST shape. */
  pullFiles: {} as Record<string, unknown[]>,
  /** What each GitHub login may do in a repository, by "owner/name#login"; read when not listed. */
  permissions: {} as Record<string, string>,
  /** Repository settings GitHub reports, by "owner/name". */
  repoSettings: {} as Record<string, Record<string, unknown>>,
  /** Branches by "owner/name#branch"; one not listed exists unprotected unless `deleted`. */
  branches: {} as Record<string, { protected?: boolean; deleted?: boolean }>,
  /** CI on a commit, by sha. */
  checks: {} as Record<
    string,
    { check_runs: { name: string; status: string; conclusion: string | null }[]; statuses: { context: string; state: string }[] }
  >,
  requests: [] as { method: string; url: string; body?: unknown; auth?: string }[],
  /** A second installation ("zeta", with repo 9): off unless a test opens it, as installs are read from `installations`. */
  otherInstallation: { id: 43, account: { login: "zeta", type: "Organization", avatar_url: "https://avatars.test/zeta" } },
  otherRepos: [{ id: 9, full_name: "zeta/site", default_branch: "main", private: true, description: null }],
  /** The repositories of installation 42 the signed-in user can reach themselves. */
  userRepos: [7, 8],
  /** Of those, the ones they can push to; the rest they can only read. */
  userPush: [7, 8],
  /** Whether installation 42 accepted the app's workflows permission. */
  workflowsGranted: true,
  /** Issues by "owner/name", in GitHub's REST shape, each with its `comment_list`. */
  issues: {} as Record<string, ({ number: number; comment_list?: unknown[] } & Record<string, unknown>)[]>,
  /** Labels a repository has, and the repositories with issues turned off (open_issues). */
  labels: {} as Record<string, string[]>,
  issuesOff: [] as string[],
  /** Whether installation 42 accepted the app's issues permission. */
  issuesGranted: true,
};

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "github.com" && url.hostname !== "api.github.com") return realFetch(input, init);
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  const auth = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
  fakeGithub.requests.push({ method, url: url.href, body, auth });

  if (url.href === "https://github.com/login/oauth/access_token") {
    return body.code === "good-code" ? Response.json({ access_token: "user-token" }) : Response.json({ error: "bad_verification_code" });
  }
  if (url.pathname === "/app") return Response.json({ id: 1234, slug: "myrel-test" });
  if (url.pathname === "/user") return Response.json({ id: 9001, login: "octo" });
  if (url.pathname === "/user/installations/42/repositories") {
    const repositories = fakeGithub.repos
      .filter((r) => fakeGithub.userRepos.includes(r.id))
      .map((r) => ({ ...r, permissions: { admin: false, maintain: false, push: fakeGithub.userPush.includes(r.id), triage: true, pull: true } }));
    return Response.json({ total_count: repositories.length, repositories });
  }
  if (url.pathname === "/user/installations/43/repositories") {
    const repositories = fakeGithub.otherRepos.map((r) => ({ ...r, permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } }));
    return Response.json({ total_count: repositories.length, repositories });
  }
  if (url.pathname === "/user/installations") {
    return Response.json({ total_count: fakeGithub.installations.length, installations: fakeGithub.installations });
  }
  const tokenMatch = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
  if (tokenMatch) {
    const installation = Number(tokenMatch[1]);
    if (installation !== 42 && installation !== 43) return new Response("{}", { status: 404 });
    const ids: number[] | undefined = body?.repository_ids;
    if (installation === 43) {
      if (ids?.some((id) => !fakeGithub.otherRepos.some((r) => r.id === id))) return new Response("{}", { status: 422 });
      const repositories = ids ? fakeGithub.otherRepos.filter((r) => ids.includes(r.id)) : undefined;
      return Response.json({ token: OTHER_INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString(), repositories });
    }
    if (ids?.some((id) => !fakeGithub.repos.some((r) => r.id === id))) return new Response("{}", { status: 422 });
    if (body?.permissions?.issues && !fakeGithub.issuesGranted) {
      return Response.json({ message: "The permissions requested are not granted to this installation." }, { status: 422 });
    }
    if (body?.permissions?.workflows && !fakeGithub.workflowsGranted) {
      return Response.json({ message: "The permissions requested are not granted to this installation." }, { status: 422 });
    }
    const repositories = ids ? fakeGithub.repos.filter((r) => ids.includes(r.id)) : undefined;
    return Response.json({ token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString(), repositories });
  }
  if (url.pathname === "/installation/token" && method === "DELETE") return new Response(null, { status: 204 });
  if (url.pathname === "/installation/repositories") {
    if (auth === OTHER_INSTALLATION_TOKEN) return Response.json({ total_count: fakeGithub.otherRepos.length, repositories: fakeGithub.otherRepos });
    return Response.json({ total_count: fakeGithub.repos.length, repositories: fakeGithub.repos });
  }
  const pulls = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls$/);
  if (pulls) {
    const repo = pulls[1]!;
    const mine = Object.entries(fakeGithub.pulls)
      .filter(([key]) => key.startsWith(`${repo}#`))
      .map(([, p]) => p as { number: number; state: string; head: { ref: string } });
    if (method === "GET") {
      const head = url.searchParams.get("head")?.split(":").at(-1);
      return Response.json(mine.filter((p) => p.state === "open" && (!head || p.head.ref === head)));
    }
    if (mine.some((p) => p.state === "open" && p.head.ref === body.head)) return new Response(JSON.stringify({ message: "A pull request already exists" }), { status: 422 });
    const number = 500 + Math.floor(Math.random() * 1e6);
    const created = {
      number,
      html_url: `https://github.com/${repo}/pull/${number}`,
      title: body.title,
      body: body.body,
      state: "open",
      draft: body.draft ?? false,
      merged: false,
      created_at: new Date().toISOString(),
      user: { login: "fibteq[bot]" },
      head: { sha: `sha-${number}`, ref: body.head, repo: { full_name: repo } },
    };
    fakeGithub.pulls[`${repo}#${number}`] = created;
    return Response.json(created, { status: 201 });
  }
  const branch = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(branches|git\/refs\/heads)\/(.+)$/);
  if (branch) {
    const key = `${branch[1]}#${decodeURIComponent(branch[3]!)}`;
    const b = fakeGithub.branches[key] ?? {};
    if (b.deleted) return new Response("{}", { status: 404 });
    if (method === "DELETE") {
      fakeGithub.branches[key] = { ...b, deleted: true };
      return new Response(null, { status: 204 });
    }
    return Response.json({ name: decodeURIComponent(branch[3]!), protected: b.protected ?? false });
  }
  const commented = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/);
  if (method === "POST" && commented) return Response.json({ html_url: `https://github.com/${commented[1]}/issues/${commented[2]}#issuecomment-1` }, { status: 201 });
  if (/^\/repos\/[^/]+\/[^/]+\/(issues\/\d+\/assignees|pulls\/\d+\/requested_reviewers)$/.test(url.pathname)) {
    return Response.json({}, { status: 201 });
  }
  const pullFiles = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files$/);
  if (pullFiles) {
    const all = fakeGithub.pullFiles[`${pullFiles[1]}#${pullFiles[2]}`] ?? [];
    const per = Number(url.searchParams.get("per_page") ?? 30);
    const page = Number(url.searchParams.get("page") ?? 1);
    return Response.json(all.slice((page - 1) * per, page * per));
  }
  const pull = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
  if (pull && method === "PATCH") {
    const key = `${pull[1]}#${pull[2]}`;
    if (!fakeGithub.pulls[key]) return new Response("{}", { status: 404 });
    fakeGithub.pulls[key] = { ...(fakeGithub.pulls[key] as object), ...body };
    return Response.json(fakeGithub.pulls[key]);
  }
  if (pull) {
    const found = fakeGithub.pulls[`${pull[1]}#${pull[2]}`];
    return found ? Response.json(found) : new Response("{}", { status: 404 });
  }
  const ci = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/(check-runs|status)$/);
  if (ci) {
    const { check_runs, statuses } = fakeGithub.checks[ci[1]!] ?? { check_runs: [], statuses: [] };
    if (ci[2] === "check-runs") return Response.json({ total_count: check_runs.length, check_runs });
    const state = statuses.some((s) => s.state !== "success") ? "pending" : "success";
    return Response.json({ state, total_count: statuses.length, statuses });
  }
  const contents = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/?(.*)$/);
  if (contents) {
    const files = fakeGithub.files[contents[1]!] ?? {};
    const path = decodeURIComponent(contents[2] ?? "");
    if (files[path] !== undefined) {
      return Response.json({ type: "file", name: path, path, size: files[path].length, encoding: "base64", content: btoa(files[path]) });
    }
    const prefix = path ? `${path}/` : "";
    const entries = new Map<string, { type: string; name: string; path: string; size: number }>();
    for (const [p, text] of Object.entries(files)) {
      if (!p.startsWith(prefix)) continue;
      const [name, ...rest] = p.slice(prefix.length).split("/");
      entries.set(name!, { type: rest.length ? "dir" : "file", name: name!, path: prefix + name, size: rest.length ? 0 : text.length });
    }
    return entries.size ? Response.json([...entries.values()]) : new Response("{}", { status: 404 });
  }
  const userById = url.pathname.match(/^\/user\/(\d+)$/);
  if (userById) return Number(userById[1]) === 9001 ? Response.json({ id: 9001, login: "octo" }) : new Response("{}", { status: 404 });
  const permission = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/);
  if (permission) return Response.json({ permission: fakeGithub.permissions[`${permission[1]}#${decodeURIComponent(permission[2]!)}`] ?? "read" });
  const merge = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/);
  if (merge && method === "PUT") {
    const key = `${merge[1]}#${merge[2]}`;
    const p = fakeGithub.pulls[key] as { head: { sha: string } } | undefined;
    if (!p) return new Response("{}", { status: 404 });
    if (body.sha && body.sha !== p.head.sha) return new Response(JSON.stringify({ message: "Head branch was modified" }), { status: 409 });
    fakeGithub.pulls[key] = { ...p, state: "closed", merged: true };
    return Response.json({ merged: true, sha: "merge-sha" });
  }
  const labels = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/labels$/);
  if (labels && method === "GET") return Response.json((fakeGithub.labels[labels[1]!] ?? []).map((name) => ({ name })));
  const issues = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+)(\/comments)?)?$/);
  if (issues && !issues[2] && method === "POST") {
    if (fakeGithub.issuesOff.includes(issues[1]!)) return Response.json({ message: "Issues are disabled for this repo" }, { status: 410 });
    const all = (fakeGithub.issues[issues[1]!] ??= []);
    const number = all.length + 100;
    const made = {
      ...(body as Record<string, unknown>),
      number,
      state: "open",
      labels: ((body as { labels?: string[] }).labels ?? []).map((name) => ({ name })),
      user: { login: "myrel-test[bot]", type: "Bot" },
      author_association: "NONE",
      created_at: "2026-11-04T10:00:00Z",
      updated_at: "2026-11-04T10:00:00Z",
      html_url: `https://github.com/${issues[1]!}/issues/${number}`,
    };
    all.push(made);
    return Response.json(made, { status: 201 });
  }
  if (issues && issues[2] && !issues[3] && method === "PATCH") {
    const all = fakeGithub.issues[issues[1]!] ?? [];
    const index = all.findIndex((i) => i.number === Number(issues[2]));
    if (index < 0) return new Response("{}", { status: 404 });
    all[index] = { ...all[index]!, ...(body as object), labels: ((body as { labels?: string[] }).labels ?? (all[index]!.labels as unknown[])) as never };
    return Response.json(all[index]);
  }
  if (issues && method === "GET") {
    const all = fakeGithub.issues[issues[1]!] ?? [];
    const strip = ({ comment_list: _, ...i }: (typeof all)[number]) => ({ ...i, comments: (_ ?? []).length });
    if (!issues[2]) return Response.json(all.map(strip));
    const issue = all.find((i) => i.number === Number(issues[2]));
    if (!issue) return new Response("{}", { status: 404 });
    if (!issues[3]) return Response.json(strip(issue));
    const perPage = Number(url.searchParams.get("per_page") ?? 30);
    const from = (Number(url.searchParams.get("page") ?? 1) - 1) * perPage;
    return Response.json((issue.comment_list ?? []).slice(from, from + perPage));
  }
  const repoMatch = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)$/);
  if (repoMatch && method === "GET") {
    const repo = fakeGithub.repos.find((r) => r.full_name === repoMatch[1]);
    return repo ? Response.json({ ...repo, ...fakeGithub.repoSettings[repo.full_name] }) : new Response("{}", { status: 404 });
  }
  return new Response(JSON.stringify({ message: "not faked" }), { status: 404 });
}) as typeof fetch;
