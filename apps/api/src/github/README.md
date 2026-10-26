# GitHub integration

Myrel talks to GitHub through a **GitHub App**. Each Myrel server needs its own app.
People connect their GitHub account in a project's settings, pick repositories, and thread
agents can then read the code in those repositories. Their tasks clone, push and open pull
requests through the same app, and the webhook keeps each pull request a thread opened up to
date: the thread shows its CI, review, conflict and merge state live, and its agent is woken
when CI fails, someone asks for changes or comments, it starts to conflict with its base
branch, or it is merged or closed. GitHub sends no event for a new conflict, so a push to a
branch makes Myrel look again at the open pull requests that merge into it.

## Quick setup

From the repository root run `node scripts/create-github-app.mjs` (Node 18+, no install) and open
http://localhost:8765. The Myrel address, organization and app name are prefilled; change them
with `--origin`, `--org` and `--name`. **Create on GitHub** sends Myrel's settings to GitHub as a
[manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest),
so GitHub only asks you to confirm, then sends you back to the local page with the five values to
add as Worker secrets (step 2). The keys are shown once, so copy them before stopping the script.

The manual steps below do the same thing by hand.

## 1. Create the GitHub App

On GitHub: **Settings → Developer settings → GitHub Apps → New GitHub App** (for an
organization: **Organization settings → Developer settings → GitHub Apps**).
Replace `https://myrel.example.com` with your server's public address.

| Field | Value |
| --- | --- |
| GitHub App name | Anything, e.g. `Fibteq Myrel`. You can rename it later. |
| Homepage URL | `https://myrel.example.com` |
| Callback URL | `https://myrel.example.com/api/github/callback` |
| Expire user authorization tokens | Either. Myrel does not keep user tokens. |
| Request user authorization (OAuth) during installation | **On** (Myrel uses it to check who installed the app) |
| Setup URL | Leave empty (GitHub disables it when the option above is on) |
| Redirect on update | On |
| Webhook → Active | On |
| Webhook URL | `https://myrel.example.com/api/github/webhook` |
| Webhook secret | A long random string (`openssl rand -hex 32`) |

**Repository permissions**

| Permission | Access |
| --- | --- |
| Contents | Read and write |
| Pull requests | Read and write |
| Issues | Read and write |
| Checks | Read-only |
| Commit statuses | Read-only |
| Metadata | Read-only (mandatory) |
| Workflows | Read and write (so agents can push changes to `.github/workflows`) |

**Subscribe to events:** Pull request, Pull request review, Pull request review comment,
Issue comment, Push, Check run, Repository. Installation events are always sent.

**Where can this GitHub App be installed?** "Only on this account" for a private server,
"Any account" if other people's accounts will connect.

After creating it, on the app's page:

1. Note the **App ID** and the **Client ID**.
2. **Generate a new client secret** and copy it.
3. **Generate a private key**. A `.pem` file downloads.

## 2. Give the Worker the settings

All five are secrets, so a deploy from `wrangler.jsonc` never wipes them. In the Cloudflare
dashboard: **Workers & Pages → myrel → Settings → Variables and Secrets → Add**, type
**Secret**. Or with wrangler from `apps/api`:

```sh
wrangler secret put GITHUB_APP_ID           # e.g. 1234567
wrangler secret put GITHUB_CLIENT_ID        # e.g. Iv23li...
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put GITHUB_WEBHOOK_SECRET   # the webhook secret from step 1
wrangler secret put GITHUB_APP_PRIVATE_KEY < your-app.private-key.pem
```

The private key can be pasted as is, including the `-----BEGIN RSA PRIVATE KEY-----` lines.
The integration stays off (the settings page says so) until all five are set. The app's
URL name (its slug) is read from GitHub, so you can rename the app on GitHub at any time
without changing anything here.

For local development put the same values in `apps/api/.dev.vars`, with a callback URL of
`http://localhost:5173/api/github/callback` on a separate development app.

## 3. Connect

Open a project, click the settings icon, then **Connect GitHub** in "GitHub repositories". Project owners and admins can connect repositories. GitHub asks which account
and repositories to install on and sends you back. If someone else (an organization admin)
already installed the app, use **Already installed? Sign in with GitHub** instead.

Connecting works from the web app, because the GitHub round trip relies on the browser's
signed-in session. The desktop and mobile apps will get their own flow.

## How it fits together

- `app.ts`: the app JWT, installation tokens and REST calls (WebCrypto, no Octokit).
- `state.ts`: the signed `state` for the round trip, and webhook signature checks.
- `store.ts`: installations per user, repositories per project, and `projectRepoToken`, which
  hands out a token limited to one project repository. Sandbox tasks clone and open pull
  requests with it.
- `files.ts`: the thread agent's `repo_list_files` and `repo_read_file` tools.
- `pulls.ts`: pull requests threads opened (`pull_requests` table; `opened_by_thread` is the thread that
  opened it, the only one `close_pull_request` lets close it, and deletes its branch after a card). A finished task's pull
  request is tracked; webhook events for it update its state, reach clients as `pr.updated`
  and wake the thread's agent when something needs it.
- `../routes/github.ts`: `/api/github` (status, connect, callback, repos, webhook).
- `../routes/projects.ts`: `/api/projects/:id/repos`.

Who can use an installation is checked when they connect: GitHub's `/user/installations`
lists only the installations that person can reach. Of the repositories the app was given on
it, a person can connect only those they can push to themselves (push, maintain or admin),
since connecting one gives Myrel's agents the app's write access to it. That list comes from
the person's last GitHub sign-in, so after migration 0027 everyone signs in to GitHub once
more the next time they pick a repository.
