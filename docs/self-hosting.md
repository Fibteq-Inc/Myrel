# Self-hosting Fibteq Myrel on Cloudflare

Myrel runs as a single Cloudflare Worker named `myrel`. The same Worker serves
the web app, the HTTP API and three Durable Object classes, and keeps accounts and
projects in a D1 database. This guide sets up your own copy and keeps it
deploying from Git with [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).

- [What you need](#what-you-need)
- [1. Get the code](#1-get-the-code)
- [2. Create the D1 database](#2-create-the-d1-database)
- [3. Set the required secret](#3-set-the-required-secret)
- [4. Connect Workers Builds](#4-connect-workers-builds)
- [5. Pick a model provider](#5-pick-a-model-provider)
- [6. Create the first account](#6-create-the-first-account)
- [Configuration reference](#configuration-reference)
- [Optional features](#optional-features)
- [Updating](#updating)
- [Deploy to Cloudflare button](#deploy-to-cloudflare-button)
- [Troubleshooting](#troubleshooting)

## What you need

- A Cloudflare account. The Workers Free plan is enough to try Myrel; heavier
  use (long agent turns, many projects) fits the Workers Paid plan better.
- A GitHub or GitLab account for Workers Builds.
- An API key for at least one model provider: Fireworks, Anthropic or OpenAI.
- Locally: Node 22+ and pnpm 10 (only for the one-time setup commands).

## 1. Get the code

Fork `Fibteq-Inc/myrel` (or push a copy to your own repository), then clone it
and install dependencies:

```sh
git clone https://github.com/<you>/myrel.git
cd myrel
pnpm install
pnpm --filter @myrel/api exec wrangler login
```

## 2. Create the D1 database

```sh
pnpm --filter @myrel/api exec wrangler d1 create myrel
```

Copy the `database_id` it prints into `apps/api/wrangler.jsonc`, replacing the
id that is there (that one belongs to the Fibteq deployment and will not work
in your account):

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "myrel",
    "database_id": "<your database id>",
    "migrations_dir": "../../packages/db/migrations"
  }
]
```

Commit and push the change. Keep the database name `myrel`: the deploy script
applies migrations to the database with that name. You do not need to run the
migrations by hand; every production deploy applies pending ones first.

### Create the R2 bucket

Project files and message uploads are stored in R2 (binding `FILES` in
`apps/api/wrangler.jsonc`). Create the bucket once; a deploy fails while it is
missing:

```sh
pnpm --filter @myrel/api exec wrangler r2 bucket create myrel-files
```

## 3. Set the required secret

Myrel needs one secret before it can start: `BETTER_AUTH_SECRET`, which signs
sessions. Setting it also creates the `myrel` Worker if it does not exist yet.

```sh
openssl rand -base64 32    # copy the output
pnpm --filter @myrel/api exec wrangler secret put BETTER_AUTH_SECRET
```

Do not change this secret later unless you want to sign everyone out.

## 4. Connect Workers Builds

In the Cloudflare dashboard, open **Workers & Pages → myrel → Settings → Build**,
choose **Connect**, pick your repository and set:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Root directory | `/` |
| Build command | `pnpm build:api` |
| Deploy command | `pnpm run deploy` |
| Non-production branch deploy command | `pnpm run deploy:preview` |

What each command does:

- `pnpm build:api` builds the web app and bundles the Worker (a `wrangler deploy --dry-run`).
- `pnpm run deploy` applies pending D1 migrations to the remote database, then runs `wrangler deploy`.
- `pnpm run deploy:preview` uploads a preview version with `wrangler versions upload`
  for every other branch. Previews share the production D1 database, so they
  never run migrations. A pull request that adds a migration only works in
  preview after it reaches `main`.

Trigger the first build by pushing to `main` (or with **Retry build**). When it
finishes, the Worker is live at `https://myrel.<your-subdomain>.workers.dev`.
To use your own domain, add it under **Settings → Domains & Routes**.

You can also deploy from a laptop without Workers Builds:
`pnpm build:api && pnpm run deploy`.

## 5. Pick a model provider

Agents call the provider named by `LLM_PROVIDER`, using that provider's key.

| `LLM_PROVIDER` | Secret | Default model |
|---|---|---|
| `fireworks` (default) | `FIREWORKS_API_KEY` | `firerouter/opus` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |
| `openai` | `OPENAI_API_KEY` | `gpt-5.1` |

Set the key:

```sh
pnpm --filter @myrel/api exec wrangler secret put FIREWORKS_API_KEY
```

or add it in the dashboard under **Settings → Variables and Secrets** (type
*Secret*). To use another provider or model, change `LLM_PROVIDER` and
`LLM_MODEL` in `apps/api/wrangler.jsonc` and push. If the key is missing, the
project chat says which secret to set instead of answering.

## 6. Create the first account

Sign-ups are off by default, so nobody can register on a fresh public server.
The simplest way in is to set the `ADMIN_EMAILS` secret to your address, then
open your Myrel URL and create your account with it: that address may sign up
while sign-ups are closed and is an admin. When the server sends email (the
`EMAIL` binding), it becomes an admin once you follow the verification link
Myrel sends, so nobody else can claim it by signing up first. Without `ADMIN_EMAILS`:

1. Set `SIGNUP_ENABLED` to `"true"` in `apps/api/wrangler.jsonc` and push (or
   set it as a plain-text variable in the dashboard).
2. Open your Myrel URL and create your account.
3. Set `SIGNUP_ENABLED` back to `"false"` and push, unless you want open sign-ups.

## Configuration reference

Plain variables live in `vars` in `apps/api/wrangler.jsonc` and are committed
with the code. Secrets are set with `wrangler secret put` or in the dashboard
and never committed. Locally, both go in `apps/api/.dev.vars` (copy
`.dev.vars.example`).

> Values set in the dashboard as plain-text variables are overwritten by
> `vars` in `wrangler.jsonc` on the next deploy. Change them in the file
> instead, or remove them from the file first.

### Secrets

| Secret | Needed for | Required |
|---|---|---|
| `BETTER_AUTH_SECRET` | Signing sessions and tokens | Always |
| `KEY_ENCRYPTION_SECRET` | Encrypting model API keys and connector credentials people save in Myrel. Falls back to `BETTER_AUTH_SECRET`; set it once and never change it, or saved keys can no longer be read | Recommended |
| `FIREWORKS_API_KEY` | Agents, when `LLM_PROVIDER` is `fireworks` | For that provider |
| `ANTHROPIC_API_KEY` | Agents, when `LLM_PROVIDER` is `anthropic` | For that provider |
| `OPENAI_API_KEY` | Agents, when `LLM_PROVIDER` is `openai` | For that provider |
| `AI_GATEWAY_TOKEN` | Calling an authenticated AI Gateway | Only with `AI_GATEWAY_URL` on an authenticated gateway |
| `ARTIFACT_SIGNING_SECRET` | Signing artifact links; set the same value on the artifact Worker | To view artifacts |
| `VAPID_PRIVATE_KEY` | Browser push notifications (with `VAPID_PUBLIC_KEY`) | No |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | GitHub integration (see [GitHub App](#github-app)) | No |
| `EXPO_ACCESS_TOKEN` | Mobile push, only if Expo enhanced push security is on | No |
| `ADMIN_EMAILS` | Comma-separated addresses of the server's admins. They may sign up while sign-ups are closed and are always admins. Unset: the first account becomes the admin | Recommended on a public server |

### Variables

| Variable | Default | Meaning |
|---|---|---|
| `BETTER_AUTH_URL` | empty | Public origin, for example `https://myrel.example.com`. Inferred from the request when empty. The cloud thread agent calls back on it, so set it when the server sits behind a proxy that changes the host. |
| `TRUSTED_ORIGINS` | empty | Extra comma-separated origins allowed to call the API cross-origin. The desktop app origins are always allowed. |
| `INSTANCE_NAME` | `Myrel` | Name shown to apps that connect to this server. |
| `SIGNUP_ENABLED` | `"false"` | `"true"` lets anyone create an account. |
| `LLM_PROVIDER` | `fireworks` | `fireworks`, `anthropic` or `openai`. |
| `LLM_MODEL` | empty | Model id; empty uses the provider's default. |
| `LLM_BASE_URL` | empty | Full override of the provider's API base URL (proxies, custom gateway routes). |
| `AI_GATEWAY_URL` | empty | `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>` to send Anthropic and OpenAI calls through AI Gateway. |
| `ARTIFACTS_URL` | Fibteq's artifact Worker | Origin of the artifact Worker, for example `https://myrel-artifacts.<your-subdomain>.workers.dev`. Empty turns artifact previews off. |
| `SANDBOX_INSTANCE_TYPE` | `standard-1` | Container size for the cloud thread agent: `lite`, `basic`, `standard-1` … `standard-4`. |
| `RUNNER_MODEL` | empty | Model for the cloud thread agent (OpenCode); empty uses the agents' model. |
| `DEFAULT_TIMEZONE` | `UTC` | IANA time zone agents use for routines when nobody names one, e.g. `Europe/Istanbul`. |
| `EMAIL_FROM` | Fibteq's address | Sender for notification emails, an address on your onboarded domain, e.g. `Myrel <myrel@example.com>`. Empty turns email off. |
| `GITHUB_APP_ID` | Fibteq's GitHub App | Your GitHub App's id. Its URL name is read from GitHub. GitHub stays off until all GitHub secrets are set too. |
| `VAPID_PUBLIC_KEY` | Fibteq's key | Web Push public key; must pair with your `VAPID_PRIVATE_KEY`, so replace it with your own. |
| `VAPID_SUBJECT` | Fibteq's contact | Contact for push services, e.g. `mailto:you@example.com`. Falls back to `BETTER_AUTH_URL`. |
| `TERMS_URL`, `PRIVACY_URL` | empty | Links to your terms and privacy policy. When both are set, signing up requires accepting them. |
| `LEGAL_VERSION` | `"1"` | Recorded with each acceptance, e.g. the documents' effective date. Change it when the documents change. |

### Bindings

These are declared in `apps/api/wrangler.jsonc` and created on deploy; you only
supply the D1 id.

| Binding | Type | Used for |
|---|---|---|
| `DB` | D1 database | Accounts, sessions, projects, membership |
| `PROJECT_AGENT` | Durable Object (`ProjectAgent`) | One per project: coordinator, project chat, live WebSocket |
| `THREAD_AGENT` | Durable Object (`ThreadAgent`) | One per thread: the thread agent and its state |
| `RUNNER_AGENT` | Durable Object (`RunnerAgent`) | One per paired computer: the myrel-runner connection and its tasks |
| `ASSETS` | Static assets | The built web app (`apps/web/dist`) |
| `ARTIFACTS` | R2 bucket `myrel-artifacts` | Artifact versions. Create the bucket before the first deploy that includes it. |
| `SANDBOX` | Durable Object (`Sandbox`) + Container | One Linux container per thread for its cloud agent (see [Code sandbox](#code-sandbox)) |
| `WORKSPACES` | Artifacts namespace `myrel` | Optional. Keeps each thread's work between tasks (see [Thread workspaces](#thread-workspaces)) |
| `EMAIL` | Email Service (`send_email`) | Optional. Notification emails (see [Notifications](#notifications)) and address verification: with it, invitations, the `ADMIN_EMAILS` admin role and the cloud sandbox wait until a person follows the link sent at sign-up. Without it, every address counts as verified. |
| `AUTH_LIMIT` | Rate limiting (`ratelimits`) | Sign-up, sign-in and their emails: 10 a minute per client IP. Optional; its `namespace_id` must be unique in your Cloudflare account. |

## Optional features

Each feature that needs extra setup gets a section here. Contributors: when a
change adds a secret, variable or binding, add it to the reference tables above
and describe the setup in a section below.

### GitHub App

Each Myrel server needs its own GitHub App for connecting repositories and
for threads to open pull requests. Run `node scripts/create-github-app.mjs`
with `--origin` set to your Myrel URL, or follow the manual steps in
[`apps/api/src/github/README.md`](../apps/api/src/github/README.md). Put the
app id and slug in `vars` and the four secrets above on the Worker.

### Cloudflare AI Gateway

[AI Gateway](https://developers.cloudflare.com/ai-gateway/) adds logs, caching,
rate limits and cost tracking to model calls.

1. Create a gateway in the dashboard under **AI → AI Gateway**.
2. Set `AI_GATEWAY_URL` to `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>`.
   Anthropic and OpenAI calls then go through it.
3. If the gateway is authenticated, set the `AI_GATEWAY_TOKEN` secret.

Fireworks has no built-in AI Gateway route. Add it to the gateway as a custom
provider and put that URL in `LLM_BASE_URL`.

### Artifacts

Thread agents publish HTML pages with `publish_artifact`. Each publish is an
immutable version in the `myrel-artifacts` R2 bucket
(`artifacts/{id}/v{n}/index.html`); the app's address for an artifact stays the
same and opens the latest version. Artifacts are untrusted HTML, so a second
Worker, `myrel-artifacts` (`apps/artifacts`), serves them from **a different
site** than the app: its own `workers.dev` address
(`https://myrel-artifacts.<your-subdomain>.workers.dev`) works, as does a
separate domain such as `myrel-usercontent.dev`, but never a subdomain of the
app's domain. It sends a strict CSP that
sandboxes each page into an opaque origin, and it only serves links the API
signed within the last hour.

1. Create the bucket **before** deploying the API, since it binds it:
   `pnpm --filter @myrel/api exec wrangler r2 bucket create myrel-artifacts`.
2. Pick one random value (`openssl rand -base64 32`) and set it as
   `ARTIFACT_SIGNING_SECRET` on both Workers:
   `pnpm --filter @myrel/api exec wrangler secret put ARTIFACT_SIGNING_SECRET` and
   `pnpm --filter @myrel/artifacts exec wrangler secret put ARTIFACT_SIGNING_SECRET`.
3. Add a second Workers Builds project on the same repository:

   | Setting | Value |
   |---|---|
   | Root directory | `/` |
   | Build command | `pnpm --filter @myrel/artifacts build` |
   | Deploy command | `pnpm run deploy:artifacts` |
   | Non-production branch deploy command | `pnpm run deploy:artifacts:preview` |

4. Optionally attach a separate domain to `myrel-artifacts` under
   **Settings → Domains & Routes**; otherwise use its `workers.dev` address.
5. Set `ARTIFACTS_URL` in `apps/api/wrangler.jsonc` to that origin, and
   `APP_ORIGINS` in `apps/artifacts/wrangler.jsonc` to the app's origin (only
   those pages may frame artifacts; empty allows any). The values in the repo
   are Fibteq's own deployment; replace them with yours.

Without `ARTIFACTS_URL`, artifacts are still published, listed and readable as
code, but the preview stays off. Locally, `pnpm dev` runs the artifact Worker
on `:8788`; copy `apps/artifacts/.dev.vars.example` too.

### Code sandbox

A thread's agent is a coding agent, not a loop of Myrel's own. In a project
with a local folder (see `myrel-runner`), it is the person's own CLI on their
computer. Otherwise it is OpenCode in the thread's own Linux container: each
turn of the thread is one OpenCode run there, which clones repositories, edits
code, runs commands and tests, and opens pull requests, and talks to people
through Myrel's tools over MCP (`/api/agent-mcp/<thread>`, with a token valid
for that turn only). Its terminal output streams into the thread. The
coordinator in the project chat stays a small loop in the Worker and never uses
a container.

- It needs [Cloudflare Containers](https://developers.cloudflare.com/containers/),
  which is on the Workers Paid plan.
- `wrangler deploy` builds the sandbox image from `apps/api/sandbox/Dockerfile`
  (git, gh, jq, ripgrep, Python with document libraries, tesseract, OpenCode) and
  pushes it to Cloudflare's registry, so Docker must be running where you deploy.
  Workers Builds has it. Later deploys push only the layers that changed, and
  containers start from the image in seconds. To deploy the Worker without
  touching the image, add `--containers-rollout=none`.
- The coding agent uses the project's model and key (the same ones the agents
  use). `RUNNER_MODEL` picks a different model for it.
- Cloning private repositories and opening pull requests uses the project's
  GitHub connection. Public repositories clone without it.
- Containers sleep after 10 idle minutes; a thread's next turn wakes its own.
- Each project chooses where its threads work under **Settings → Tasks**:
  automatic (on the computer with the project's local folder while
  `myrel-runner` is online there, otherwise in this sandbox), always on that
  computer, or always in the cloud.

To run without a sandbox, remove the `SANDBOX` binding and the `containers`
block from `apps/api/wrangler.jsonc` (keep the migrations). Threads of projects
without a local folder then say there is no sandbox.

### Thread workspaces

A container's disk does not survive its sleep. With
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) (beta,
Workers Paid), each thread gets its own git repository, `thread-<thread id>`
in the `myrel` namespace. The sandbox commits and pushes every task's work
there, unfinished work included, and the thread's next task starts from it:
without a repository it continues in the same files, and with one it
continues the same branch.

Artifacts has no local emulator, so `wrangler dev` needs a Cloudflare login
while the `WORKSPACES` binding is in `apps/api/wrangler.jsonc` (the API tests
leave it out on their own). To run without it, remove the `artifacts` block;
tasks then keep only what they push to GitHub.

### Routines

Routines are scheduled wake-ups: a prompt that runs on a cron schedule (in a
time zone) or once at a set time. People create them from the alarm clock button in
the project chat's header, or by asking Myrel ("every weekday at 9, summarize open
threads"). Each run either posts in the project chat, where the coordinator
opens a thread for it, or wakes an existing thread. They run on Durable Object
alarms, so they need no setup. Set `DEFAULT_TIMEZONE` to your team's zone.

### Skills

Skills are instructions with optional files (a `SKILL.md` plus scripts or
references) that thread agents load when a task fits. A person adds them for
themselves, or for a project, under Settings: written in the app, or taken from
a GitHub repository or a skills.sh link. A GitHub skill remembers its commit, so
updating it is a choice. They live in D1 and need no setup; up to 40 reach one
turn, project skills first.

### Connectors

Connectors are MCP servers people add so thread agents can use other services.
There are two kinds:

- **Remote** (`https://…`, with OAuth or headers): the Worker proxies each call
  and adds the stored credentials, so the agent never holds them. Private and
  local addresses are refused. The OAuth redirect is
  `<your origin>/api/connectors/oauth/callback`.
- **Command** (stdio): runs next to the agent, in the cloud sandbox or on the
  person's own computer through the runner.

The settings offer ready-made ones (Fibteq Flow, Linear, Notion, Sentry,
PostgreSQL); the list is `CONNECTOR_PRESETS` in `packages/protocol/src/connectors.ts`.
Connector credentials are encrypted with `KEY_ENCRYPTION_SECRET`.

### Hosted plans

`ee/billing` holds the plans and Stripe billing of the hosted service at
myrel.fibteq.io, under a separate license. A self-hosted server does not use it
and has no limits.

### Notifications

Members are notified when a thread finishes, replies, needs a decision, is
blocked or fails. The in-app list (the bell in the rail) always works. Each
person turns email and browser push on or off under the bell.

- **Email** goes through
  [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)
  via the `EMAIL` (`send_email`) binding. In the dashboard, open
  **Compute → Email Service → Email Sending → Onboard Domain** and add your
  domain (it must use Cloudflare DNS; onboarding adds the SPF, DKIM and DMARC
  records). Sending to arbitrary addresses needs the Workers Paid plan. Then
  set `EMAIL_FROM` to an address on that domain. Only finished, decision,
  blocked and failed events are emailed. Set `BETTER_AUTH_URL` so the links in
  emails point at your server. `wrangler dev` only simulates sends; remove the
  `send_email` block to run without email.
- **Browser push** uses Web Push with VAPID keys. Generate a pair once with
  `pnpm --filter @myrel/api vapid`, put `VAPID_PUBLIC_KEY` (and
  `VAPID_SUBJECT`) in the variables and `VAPID_PRIVATE_KEY` in the secrets.
  Changing the pair later invalidates every browser subscription.
- **Mobile push** for the Expo app needs nothing on the server: the app
  registers its Expo push token through `POST /api/notifications/subscriptions`.

### Web UI on another origin

The Worker serves the web app on the same origin, using session cookies. To
serve the UI somewhere else (another domain, the desktop app), build it with
`VITE_API_URL=https://<api-origin>`. It then signs in with bearer tokens, and
the API must allow its origin through `TRUSTED_ORIGINS`.

### Desktop and mobile apps

The apps are not tied to one server. On the sign-in screen the user enters any
Myrel address; the app checks `GET /api/info` (it must be a Myrel server
with the same API version) and keeps a separate sign-in per server. Set
`INSTANCE_NAME` so people can tell your server apart.

## Updating

Pull changes from upstream into your fork and push to `main`:

```sh
git remote add upstream https://github.com/Fibteq-Inc/myrel.git   # once
git fetch upstream
git merge upstream/main
git push
```

Workers Builds deploys the new version and applies new migrations. Keep your
own `database_id` when resolving the conflict in `wrangler.jsonc`. Read the
release notes before updating while Myrel is pre-1.0: migrations only move
forward, so back up D1 first (**D1 → myrel → Time Travel** can restore to a
point in time).

## Deploy to Cloudflare button

A one-click "Deploy to Cloudflare" button is planned but not available yet. The
button provisions the resources declared in a Worker's Wrangler config, but it
does not fully support monorepos: an app in a subdirectory must carry all of its
dependencies, and `apps/api` depends on workspace packages. Until the repository
has a layout the button can build, use the steps above.

## Troubleshooting

- **The project chat says a secret is missing.** Set the key for the provider in
  `LLM_PROVIDER` and redeploy, or wait a few seconds for the secret to apply.
- **Build fails on `d1 migrations apply`.** The `database_id` in `wrangler.jsonc`
  does not belong to your account, or the database is not named `myrel`.
- **Sign-in works locally but not in production.** Check `BETTER_AUTH_URL`
  matches your public origin, or leave it empty.
- **Cross-origin requests are rejected.** Add the UI's origin to `TRUSTED_ORIGINS`.
- **Nobody can register.** Sign-ups are off by default; see
  [Create the first account](#6-create-the-first-account).
