import type { InstanceRole } from "@myrel/protocol";
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

  let session = await createAuth(c.env).api.getSession({ headers });
  // A session made a moment ago may not have reached the replica this request reads from yet.
  const signedIn = headers.has("authorization") || headers.has("cookie");
  if (!session && signedIn && c.env.DB_PRIMARY) session = await createAuth({ ...c.env, DB: c.env.DB_PRIMARY }).api.getSession({ headers });
  if (!session) return c.json({ error: "unauthorized" }, 401);

  const { id, name, email, role, emailVerified } = session.user;
  const admin = role === "admin" || isListedAdmin(c.env, email, emailVerified);
  c.set("user", { id, name, email, role: admin ? "admin" : "user", verified: isVerified(c.env, emailVerified) });
  c.set("session", { id: session.session.id, expiresAt: new Date(session.session.expiresAt).getTime() });
  await next();
});

/** For server administration routes; runs after requireUser. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
  await next();
});
