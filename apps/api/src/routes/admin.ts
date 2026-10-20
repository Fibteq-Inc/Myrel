import { type AdminSettings, UpdateAdminSettingsInput } from "@myrel/protocol";
import { Hono } from "hono";
import { setSignUpEnabled, signUpEnabled } from "../instance";
import { type AppEnv, requireAdmin, requireUser } from "../middleware";

/** Server settings for instance admins. */
export const adminRoutes = new Hono<AppEnv>()
  .use(requireUser, requireAdmin)
  .get("/settings", async (c) => c.json({ settings: { signUpEnabled: await signUpEnabled(c.env) } satisfies AdminSettings }))
  .patch("/settings", async (c) => {
    const input = UpdateAdminSettingsInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    if (input.data.signUpEnabled !== undefined) await setSignUpEnabled(c.env, input.data.signUpEnabled);
    return c.json({ settings: { signUpEnabled: await signUpEnabled(c.env) } satisfies AdminSettings });
  });
