/** npm's registry for tests: the newest myrel-runner is always this one. */
export const FAKE_LATEST_RUNNER = "0.13.0";

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "registry.npmjs.org") return realFetch(input, init);
  if (url.pathname === "/@fibteq%2Fmyrel-runner/latest") return Response.json({ name: "@fibteq/myrel-runner", version: FAKE_LATEST_RUNNER });
  return new Response("{}", { status: 404 });
}) as typeof fetch;
