# Going public: maintainer checklist

Steps to finish before the repository goes public, and right after. Tick them
off in the pull request that flips visibility, or keep this file updated.

## Already done

- [x] Full git history scanned for leaked secrets with gitleaks 8.28.0
      (2026-10-19, 13 commits, no findings; re-run 2026-10-20 with 8.21.2 over
      all 101 commits on every branch and pull request ref: one false positive,
      the RSA key `apps/api/vitest.config.ts` generates for tests; re-run again
      2026-10-20 over all 294 commits on every branch and pull request ref, same
      single false positive; re-run 2026-10-21 with 8.28.0 over all 368 commits
      on every branch, tag and pull request ref, plus the working tree: no
      findings. A pattern search of the whole history for Fireworks, Anthropic,
      OpenAI, Stripe, GitHub, AWS, Slack, Resend and RevenueCat keys and JWTs
      found nothing either). The `Secret scan` workflow keeps scanning every
      pull request and push to `main`.
- [x] Workflows hardened (2026-10-21): third-party actions that hold secrets or
      a write token (`contributor-assistant/github-action`,
      `tauri-apps/tauri-action`) are pinned to commits, CI runs with a read-only
      token, and the gitleaks download is checked against its SHA-256. The CLA
      workflow uses `pull_request_target` but never checks out pull request
      code. Pull requests never run on the self-hosted Mac, and once the
      repository is public nothing does (`desktop.yml`).
- [x] Application review on `main` (2026-10-21) after #121, #125 and #132:
      no open finding blocks going public.
- [x] Second review on `main` (2026-10-22): gitleaks over files and the full
      history of every branch found nothing to rotate. Fixes merged in #178
      (plan limits re-checked while a turn runs, Turnstile on sign-up, push
      subscription checks, runner pairing rate limit, desktop CSP) and #183
      (forwarded follow-ups, push-capable GitHub repositories only, runner
      token kept out of child processes, scoped git credential helper).
- [x] AGPL-3.0 `LICENSE`, `ee/LICENSE` for enterprise code, `CLA.md`.
- [x] README, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
      issue and pull request templates.
- [x] Self-hosting guide in `docs/self-hosting.md`.
- [x] `cla-signatures` branch created.
- [x] Runner published as `myrel-runner` and `@fibteq/myrel-runner`; the old
      `altair-runner` and `@fibteq/altair-runner` are deprecated with a pointer.
- [x] No "altair" left in the code except the sandbox container application
      name `altair-sandbox`, which cannot change (see `apps/api/wrangler.jsonc`).

## Before flipping to public

- [ ] Trademark: the project was renamed from Altair to Myrel (2026-10-20)
      because of Altair Engineering. Clear "Myrel" in software classes 9 and
      42; similar-sounding AI companies to ask about are Myrl Tech and
      Miriel AI. The docs use "Fibteq Myrel" everywhere a name is shown.
- [ ] Confirm the contact addresses exist and are monitored:
      `security@fibteq.com` (SECURITY.md) and `conduct@fibteq.com`
      (CODE_OF_CONDUCT.md).
- [ ] Commits authored as `Claude <noreply@anthropic.com>` are not linked to a
      GitHub account, so the CLA bot will flag them: keep Claude-made changes
      co-authored rather than authored once the repository is public, or extend
      the allowlist.
- [ ] The connector presets feature Fibteq Flow (`packages/protocol/src/connectors.ts`)
      for every server, self-hosted ones included. Keep that or limit it to the
      hosted service.
- [ ] Have a lawyer review `ee/LICENSE` and `CLA.md`. Both are reasonable
      starting points, not legal advice.
- [x] `VAPID_SUBJECT` in `apps/api/wrangler.jsonc` is the team address
      `myrel@fibteq.app` (it was a personal one). Six early commits are
      authored with a `fibteq.com` address, which stays in public history.
- [ ] Decide what to do with the production D1 `database_id` in
      `apps/api/wrangler.jsonc`. It is not a secret, but forks cannot use it;
      the self-hosting guide tells them to replace it.

- [ ] Create the Turnstile widget for the hosted server and set
      `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` (sign-up has no challenge
      until then).
- [ ] Build the desktop app with the new CSP and smoke-test sign-in, the
      runner and opening links.

- [ ] Org Settings → Actions → Runner groups: the group with the self-hosted
      Mac keeps **Allow public repositories** off. A fork pull request can edit
      `desktop.yml` to ask for that runner; this setting is what stops it.
- [ ] Repository (or org) Settings → Actions → General → *Fork pull request
      workflows from outside collaborators*: **Require approval for all
      external contributors**.
- [ ] Same page, *Workflow permissions*: **Read repository contents and
      packages permissions** as the default (the workflows ask for more where
      they need it).
- [ ] Cloudflare → Workers & Pages → `myrel` and `myrel-artifacts` → Settings →
      Build: check which branches get preview builds. Previews run with the
      production secrets and the production D1 database. Workers Builds only
      builds branches pushed to this repository, not forks, so only people with
      write access can trigger one; keep it that way (no outside collaborators
      with write access).

## Right after going public

- [ ] Settings → Code security: turn on **Private vulnerability reporting**,
      **Secret scanning**, **Push protection**, **Dependabot alerts** and
      **Dependabot security updates**.
- [ ] Settings → General: enable **Discussions** (the issue template links to it).
- [ ] Ruleset on `main` (it has no protection today): block force pushes and
      deletion, require the `CI` and `Secret scan` checks (and `CLA`). Do not
      require an approving review while there is a single maintainer: GitHub
      does not let an author approve their own pull request, so it would block
      every merge; add it when a second maintainer joins.
- [ ] Delete merged `claude/*` branches; keep `cla-signatures`.
- [ ] Add topics and a description to the repository: `ai-agents`, `cloudflare-workers`,
      `durable-objects`, `self-hosted`, `claude`, `llm`.
- [ ] Deploy to Cloudflare button: test it on the public repository. The
      button needs the app to build from one directory with its own
      dependencies; with the current pnpm monorepo it likely needs a root-level
      Wrangler config or a separate template repository. Add the button to the
      README only after a test deploy works.
