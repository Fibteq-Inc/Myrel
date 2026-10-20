# Going public: maintainer checklist

Steps to finish before the repository goes public, and right after. Tick them
off in the pull request that flips visibility, or keep this file updated.

## Already done

- [x] Full git history scanned for leaked secrets with gitleaks 8.28.0
      (2026-10-19, 13 commits, no findings; re-run 2026-10-20 with 8.21.2 over
      all 101 commits on every branch and pull request ref: one false positive,
      the RSA key `apps/api/vitest.config.ts` generates for tests; re-run again
      2026-10-20 over all 294 commits on every branch and pull request ref, same
      single false positive). The `Secret scan` workflow keeps scanning every
      pull request and push to `main`.
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
- [ ] `VAPID_SUBJECT` in `apps/api/wrangler.jsonc` is a personal address;
      swap it for a team mailbox if that matters. Six early commits are also
      authored with a `fibteq.com` address, which stays in public history.
- [ ] Decide what to do with the production D1 `database_id` in
      `apps/api/wrangler.jsonc`. It is not a secret, but forks cannot use it;
      the self-hosting guide tells them to replace it.

## Right after going public

- [ ] Settings → Code security: turn on **Private vulnerability reporting**,
      **Secret scanning** and **Push protection**.
- [ ] Settings → General: enable **Discussions** (the issue template links to it).
- [ ] Branch protection on `main`: require the `CI`, `Secret scan` and `CLA`
      checks and one review.
- [ ] Add topics and a description to the repository: `ai-agents`, `cloudflare-workers`,
      `durable-objects`, `self-hosted`, `claude`, `llm`.
- [ ] Deploy to Cloudflare button: test it on the public repository. The
      button needs the app to build from one directory with its own
      dependencies; with the current pnpm monorepo it likely needs a root-level
      Wrangler config or a separate template repository. Add the button to the
      README only after a test deploy works.
