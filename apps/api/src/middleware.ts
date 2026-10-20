import type { InstanceRole } from "@myrel/protocol";
import { createMiddleware } from "hono/factory";
import { createAuth } from "./auth";

export type SessionUser = { id: string; name: string; email: string; role: InstanceRole };
export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };

/**
 * Resolves the Better Auth session from cookies or `Authorization: Bearer`.
 * WebSocket clients that cannot set headers may pass `?token=` instead.
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const headers = new Headers(c.req.raw.headers);
  const token = c.req.query("token");
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);

  const session = await createAuth(c.env).api.getSession({ headers });
  if (!session) return c.json({ error: "unauthorized" }, 401);

  const { id, name, email, role } = session.user;
  c.set("user", { id, name, email, role: role === "admin" ? "admin" : "user" });
  await next();
});

/** For server administration routes; runs after requireUser. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
  await next();
});
