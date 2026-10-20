import { z } from "zod";

/**
 * Version of the client/server API contract. Bump on breaking changes; apps
 * refuse servers with a different major so a stale desktop or mobile build
 * fails clearly instead of half-working against a newer self-hosted server.
 */
export const API_VERSION = 1;

/** Returned by `GET /api/info`, so an app can check an address before signing in. */
export const ServerInfo = z.object({
  app: z.literal("myrel"),
  apiVersion: z.number().int().positive(),
  /** Display name of this deployment, e.g. "Myrel Cloud" or a company's self-hosted instance. */
  name: z.string(),
  auth: z.object({
    emailPassword: z.boolean(),
    /** Whether new accounts can be created. Older servers do not send it and always allowed it. */
    signUp: z.boolean().default(true),
  }),
});
export type ServerInfo = z.infer<typeof ServerInfo>;
