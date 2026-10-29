import type { InstanceRole } from "@myrel/protocol";
import { APIError } from "better-auth/api";
import { createMiddleware } from "hono/factory";
import { createAuth } from "./auth";
import { isListedAdmin } from "./instance";
import { isVerified } from "./verification";

/** `verified`: the address is the person's (see verification.ts). */
export type SessionUser = { id: string; name: string; email: string; role: InstanceRole; verified: boolean };
/** The signed-in session itself, for a WebSocket that must end with it. */
export type SessionInfo = { id: string; expiresAt: number };
export type AppEnv = { Bindings: Env; Variables: { user: SessionUser; session: SessionInfo } };

/**
 * Resolves the Better Auth session from cookies or `Authorization: Bearer`.
 * WebSocket clients that cannot set headers may pass `?token=` instead; only a WebSocket upgrade
 * may, so a session token never has to sit in an ordinary URL (and the logs and history that keep them).
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const headers = new Headers(c.req.raw.headers);
  const token = c.req.header("upgrade")?.toLowerCase() === "websocket" ? c.req.query("token") : undefined;
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);

  // A session made a moment ago may not have reached the replica this request reads from yet.
  const primary = c.env.DB_PRIMARY ? { ...c.env, DB: c.env.DB_PRIMARY } : c.env;
  let session = await findSession(c.env, headers).catch(() => findSession(primary, headers));
  const signedIn = headers.has("authorization") || headers.has("cookie");
  if (!session && signedIn && c.env.DB_PRIMARY) session = await findSession(primary, headers);
  if (!session) return c.json({ error: "unauthorized" }, 401);

  const { id, name, email, role, emailVerified } = session.user;
  const admin = role === "admin" || isListedAdmin(c.env, email, emailVerified);
  c.set("user", { id, name, email, role: admin ? "admin" : "user", verified: isVerified(c.env, emailVerified) });
  c.set("session", { id: session.session.id, expiresAt: new Date(session.session.expiresAt).getTime() });
  await next();
});

/**
 * Better Auth's getSession, with a session it gave up on counted as none: it throws a 401
 * "Failed to get session" when the session vanished while being refreshed (signed out elsewhere,
 * or the replica still had a row the primary had dropped), which would otherwise surface as a 500.
 * Anything else (a database hiccup, the same message with a 500) still throws, for the caller to retry.
 */
async function findSession(env: Env, headers: Headers) {
  try {
    return await createAuth(env).api.getSession({ headers });
  } catch (err) {
    if (err instanceof APIError && err.statusCode === 401) return null;
    throw err;
  }
}

/** For server administration routes; runs after requireUser. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
  await next();
});
