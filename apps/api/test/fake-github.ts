/**
 * A tiny in-memory GitHub for tests: one installation (42, org "acme") that
 * covers repos 7 (acme/app) and 8 (acme/docs). Requests are recorded so tests
 * can check what Myrel asked for.
 */
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
  /** CI on a commit, by sha. */
  checks: {} as Record<
    string,
    { check_runs: { name: string; status: string; conclusion: string | null }[]; statuses: { context: string; state: string }[] }
  >,
  requests: [] as { method: string; url: string; body?: unknown }[],
};

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "github.com" && url.hostname !== "api.github.com") return realFetch(input, init);
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  fakeGithub.requests.push({ method, url: url.href, body });

  if (url.href === "https://github.com/login/oauth/access_token") {
    return body.code === "good-code" ? Response.json({ access_token: "user-token" }) : Response.json({ error: "bad_verification_code" });
  }
  if (url.pathname === "/app") return Response.json({ id: 1234, slug: "myrel-test" });
  if (url.pathname === "/user") return Response.json({ id: 9001, login: "octo" });
  if (url.pathname === "/user/installations") {
    return Response.json({ total_count: fakeGithub.installations.length, installations: fakeGithub.installations });
  }
  const tokenMatch = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
  if (tokenMatch) {
    if (Number(tokenMatch[1]) !== 42) return new Response("{}", { status: 404 });
    const ids: number[] | undefined = body?.repository_ids;
    if (ids?.some((id) => !fakeGithub.repos.some((r) => r.id === id))) return new Response("{}", { status: 422 });
    const repositories = ids ? fakeGithub.repos.filter((r) => ids.includes(r.id)) : undefined;
    return Response.json({ token: "inst-token", expires_at: new Date(Date.now() + 3600_000).toISOString(), repositories });
  }
  if (url.pathname === "/installation/repositories") {
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
      head: { sha: `sha-${number}`, ref: body.head },
    };
    fakeGithub.pulls[`${repo}#${number}`] = created;
    return Response.json(created, { status: 201 });
  }
  if (/^\/repos\/[^/]+\/[^/]+\/(issues\/\d+\/assignees|pulls\/\d+\/requested_reviewers)$/.test(url.pathname)) {
    return Response.json({}, { status: 201 });
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
  return new Response(JSON.stringify({ message: "not faked" }), { status: 404 });
}) as typeof fetch;
