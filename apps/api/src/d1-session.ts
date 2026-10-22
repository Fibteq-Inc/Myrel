/**
 * D1 read replication (Sessions API). Each request to the Worker runs on one D1 session, so its
 * reads may come from a nearby replica while staying consistent with its own writes and with the
 * bookmark the app sent (BOOKMARK_HEADER), so what a person saved is there on their next request.
 * With replication off on the database, every query still goes to the primary, as before.
 *
 * Durable Objects and the cron keep the plain binding (always the primary): their D1 reads mostly
 * follow their own writes or writes made a moment before by another request.
 */

export const BOOKMARK_HEADER = "x-d1-bookmark";

type Fetch<Ctx> = (request: Request, env: Env, ctx: Ctx) => Response | Promise<Response>;

/**
 * Where a request's session starts. Only a caller that sends the bookmark of its last answer (the
 * apps, see @myrel/client) may read from a replica, and only one at least that fresh. Everything else
 * (sign-in, webhooks, OAuth and GitHub callbacks the browser lands on, a page's first request) starts
 * on the primary, so it sees what another request has just written.
 */
export function sessionStart(request: Request): string {
  if (new URL(request.url).pathname.startsWith("/api/auth/")) return "first-primary";
  const bookmark = request.headers.get(BOOKMARK_HEADER);
  // D1's bookmarks are hex groups joined by dashes; anything else would fail the request's queries.
  return bookmark && /^[0-9a-f]+(-[0-9a-f]+)+$/i.test(bookmark) && bookmark.length <= 200 ? bookmark : "first-primary";
}

/**
 * Runs `fetch` with `env.DB` as this request's session and returns the session's bookmark. A request
 * already on a session (the hosted Worker wraps the core one) keeps it.
 */
export function withD1Session<Ctx>(fetch: Fetch<Ctx>): Fetch<Ctx> {
  return async (request, env, ctx) => {
    if (env.DB_PRIMARY) return fetch(request, env, ctx);
    const session = env.DB.withSession(sessionStart(request));
    // A session has the binding's prepare and batch, all the code here uses; withSession, exec and
    // dump stay on DB_PRIMARY. Drizzle's types only name D1Database, hence the cast.
    const scoped: Env = { ...env, DB: session as unknown as D1Database, DB_PRIMARY: env.DB };
    const res = await fetch(request, scoped, ctx);
    const bookmark = session.getBookmark();
    if (!bookmark || res.status === 101) return res;
    try {
      res.headers.set(BOOKMARK_HEADER, bookmark);
      return res;
    } catch {
      // Immutable headers (a response passed through from fetch or an asset).
      const copy = new Response(res.body, res);
      copy.headers.set(BOOKMARK_HEADER, bookmark);
      return copy;
    }
  };
}
