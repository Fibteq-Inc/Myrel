import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./middleware";

/**
 * Better Auth endpoints a script would hammer: creating accounts, guessing passwords, and the
 * emails they send. Better Auth's own limiter keeps counts in memory, which does nothing across
 * Workers isolates, so these go through the AUTH_LIMIT binding (wrangler.jsonc) per client IP.
 */
const LIMITED = ["/sign-up/", "/sign-in/", "/send-verification-email", "/request-password-reset", "/forget-password", "/change-password"];

export const authLimit = createMiddleware<AppEnv>(async (c, next) => {
  const limiter = (c.env as Partial<Env>).AUTH_LIMIT;
  // Cloudflare sets the header on every request it serves; without it (tests, a local dev server) there is no client to count.
  const ip = c.req.header("cf-connecting-ip");
  if (limiter && ip && c.req.method === "POST" && LIMITED.some((p) => c.req.path.includes(p))) {
    const { success } = await limiter.limit({ key: ip });
    if (!success) return c.json({ code: "TOO_MANY_REQUESTS", message: "Too many attempts. Wait a minute and try again." }, 429);
  }
  await next();
});
