# Altair

Altair is an open-source, self-hostable workspace for working with AI agents in
projects, in the spirit of Claude Projects: a project chat with a coordinator,
threads where agents do the work, artifacts, and memory. It runs entirely on
Cloudflare (Workers, Durable Objects, D1, R2) and has a typed API shared by the
web app and a future mobile app.

> Status: phase 1. Ask for something in the project chat and the coordinator
> opens a thread for it; the thread's agent answers there, shows its progress
> checklist, and asks the coordinator when something is beyond its scope.
> Agents only talk for now: no tools, sandbox or web access yet.

## Stack

- **API**: [Hono](https://hono.dev) on Cloudflare Workers, [Better Auth](https://better-auth.com)
  (email + password, bearer tokens for mobile), D1 via [Drizzle](https://orm.drizzle.team)
- **Agents**: the coordinator runs in the `ProjectAgent` and only routes (`post_message`, `start_thread`,
  `message_thread`, `react`); each thread has a `ThreadAgent` that does the work (`reply`, `update_status`,
  `request_coordinator`, `resolve_thread`). Both use a small provider-neutral loop in `apps/api/src/llm`.
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
cp apps/api/.dev.vars.example apps/api/.dev.vars    # set BETTER_AUTH_SECRET and a model key
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
   | Non-production branch deploy command | `pnpm run deploy:preview` |

`pnpm run deploy` applies pending D1 migrations, then runs `wrangler deploy`. Other branches (pull requests) only upload a preview version with `wrangler versions upload`; previews share the production D1 database, so they never run migrations.

Manual deploy from a laptop: `pnpm build:api && pnpm run deploy`.

### Models

Agents call the model named by `LLM_PROVIDER` in `wrangler.jsonc`, with that provider's key as a Worker secret:

| `LLM_PROVIDER` | Secret | Default model |
|---|---|---|
| `fireworks` (default) | `FIREWORKS_API_KEY` | `firerouter/opus` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |
| `openai` | `OPENAI_API_KEY` | `gpt-5.1` |

Set the key with `pnpm --filter @altair/api exec wrangler secret put FIREWORKS_API_KEY` (or in the dashboard under Settings → Variables and Secrets), and override the model with `LLM_MODEL`. Without a key, the project chat shows which secret is missing.

To route calls through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) (logs, caching, cost tracking), set `AI_GATEWAY_URL` to `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>`; Anthropic and OpenAI calls then go through it, and `AI_GATEWAY_TOKEN` (secret) authenticates an authenticated gateway. Fireworks has no built-in gateway route: add it to the gateway as a custom provider and put that URL in `LLM_BASE_URL`.

### Web UI on another origin

The Worker serves the web app same-origin, using session cookies. To run the UI elsewhere (the desktop app, a separate domain), build it with `VITE_API_URL=https://<api-origin>`. It then uses bearer tokens, and the API must allow its origin through `TRUSTED_ORIGINS`; the desktop app origins are always allowed.

### Connecting apps to a self-hosted server

The desktop and mobile apps are not tied to one server. On the sign-in screen the user enters any Altair address; the app checks `GET /api/info` (it must be an Altair server with the same API version) and keeps a separate sign-in per server. Set `INSTANCE_NAME` in `wrangler.jsonc` to name your deployment.

### Sign-ups

New accounts are off by default: only existing accounts can sign in. Set `SIGNUP_ENABLED` to `"true"` in `wrangler.jsonc` to let anyone register (`.dev.vars.example` turns it on for local development).

## License

[AGPL-3.0](LICENSE)
