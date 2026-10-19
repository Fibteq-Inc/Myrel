# Altair

Altair is an open-source, self-hostable workspace for working with AI agents in
projects, in the spirit of Claude Projects: a project chat with a coordinator,
threads where agents do the work, artifacts, and memory. It runs entirely on
Cloudflare (Workers, Durable Objects, D1, R2) and has a typed API shared by the
web app and a future mobile app.

> Status: phase 0 (skeleton). Sign up, create a project, and chat in an empty
> project room over WebSocket. No agents yet.

## Stack

- **API**: [Hono](https://hono.dev) on Cloudflare Workers, [Better Auth](https://better-auth.com)
  (email + password, bearer tokens for mobile), D1 via [Drizzle](https://orm.drizzle.team)
- **Realtime**: one `ProjectAgent` Durable Object per project ([Agents SDK](https://developers.cloudflare.com/agents/)),
  messages in its SQLite with a monotonically increasing `seq` for reconnect sync
- **Web**: Vite, React 19, TanStack Router + Query, Tailwind CSS 4, served by the same Worker
- **Shared**: `packages/protocol` (zod schemas), `packages/client` (fetch + WebSocket client for web and React Native)
- **Tooling**: pnpm workspaces, Turborepo, TypeScript, Vitest (`@cloudflare/vitest-plugin`)

```
apps/api         Hono Worker, Durable Objects (ProjectAgent, ThreadAgent)
apps/web         Vite + React SPA
packages/protocol  message/thread/project types, WebSocket events
packages/client    typed API client + reconnecting project socket
packages/db        Drizzle schema and D1 migrations
```

## Quickstart

Requires Node 22+ and pnpm 10.

```sh
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars    # set BETTER_AUTH_SECRET
pnpm db:migrate:local                               # wrangler d1 migrations apply altair --local
pnpm dev                                            # API on :8787, web on http://localhost:5173
```

Other scripts: `pnpm typecheck`, `pnpm test`, `pnpm build`.
After changing `packages/db/src/schema.ts`, run `pnpm db:generate` to create a migration.

## Deploy

Altair deploys with [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/): every push to `main` builds and deploys the `altair` Worker.

One-time setup:

1. Create the D1 database (`pnpm --filter @altair/api exec wrangler d1 create altair`) and put its id in `apps/api/wrangler.jsonc`.
2. Set the auth secret, which also creates the Worker if it does not exist yet:
   `pnpm --filter @altair/api exec wrangler secret put BETTER_AUTH_SECRET` (value: `openssl rand -base64 32`).
3. In the Cloudflare dashboard, open Workers & Pages → `altair` → Settings → Build → Connect, pick this repository, and set:

   | Setting | Value |
   |---|---|
   | Branch | `main` |
   | Root directory | `/` |
   | Build command | `pnpm build:api` |
   | Deploy command | `pnpm run deploy` |

`pnpm run deploy` applies pending D1 migrations, then runs `wrangler deploy`.

Manual deploy from a laptop: `pnpm build:api && pnpm run deploy`.

### Web UI on another origin

The Worker serves the web app same-origin, using session cookies. To run the UI elsewhere (the desktop app, a separate domain), build it with `VITE_API_URL=https://<api-origin>`. It then uses bearer tokens, and the API must allow its origin through `TRUSTED_ORIGINS`; the desktop app origins are always allowed.

## License

[AGPL-3.0](LICENSE)
