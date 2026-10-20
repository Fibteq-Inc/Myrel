# Contributing to Fibteq Myrel

Thanks for helping. This page covers how to set up the project, what we expect
in a pull request, and the Contributor License Agreement.

## Before you start

- For a bug, open an issue with the bug report form, or go straight to a pull
  request if the fix is small.
- For a feature or a larger change, open a feature request or a discussion
  first, so we can agree on the approach before you spend time on it.
- Security issues never go in public issues. See [SECURITY.md](SECURITY.md).

## Development setup

Requires Node 22+ and pnpm 10.

```sh
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars    # set BETTER_AUTH_SECRET and a model key
pnpm db:migrate:local
pnpm dev                                            # API on :8787, web on http://localhost:5173
```

Useful commands:

| Command | What it does |
|---|---|
| `pnpm typecheck` | Type-checks every package |
| `pnpm test` | Runs the Vitest suites (the API tests run inside the Workers runtime) |
| `pnpm build` | Builds the web app and bundles the Worker |
| `pnpm db:generate` | Creates a D1 migration after you change `packages/db/src/schema.ts` |

The API tests use a fake model (`apps/api/test/fake-llm.ts`), so they need no
API key.

[docs/architecture.md](docs/architecture.md) explains how the pieces fit
together.

## Pull requests

- Keep each pull request to one change. Small pull requests get reviewed faster.
- Describe what a user would see before and after the change.
- Run `pnpm typecheck` and `pnpm test` before pushing; CI runs the same checks
  plus `pnpm build` and a secret scan.
- Add or update tests for behavior you change.
- Schema changes need a migration from `pnpm db:generate`. Migrations only
  move forward; never edit one that is already on `main`.
- If you add a variable, secret or binding, document it in
  [docs/self-hosting.md](docs/self-hosting.md#configuration-reference) in the
  same pull request. Features that need extra setup get their own section under
  "Optional features" there.
- Follow the style of the code around you. Code is TypeScript with strict
  settings, two-space indentation and comments only where the reason is not
  obvious.
- Use [Conventional Commits](https://www.conventionalcommits.org) style for
  commit messages and pull request titles, for example `feat: add project files`
  or `fix(api): keep seq after reconnect`.

## Contributor License Agreement

Before we can merge your first pull request, you need to sign the
[Contributor License Agreement](CLA.md). A bot comments on the pull request
with instructions; you sign by replying with the sentence it gives. You only
sign once.

The CLA lets Fibteq offer Myrel under commercial terms (the hosted service
and the enterprise license) as well as under the AGPL. You keep the copyright
to your work.

## Licensing of contributions

- Code outside `ee/` is licensed under AGPL-3.0.
- Code in `ee/` is under the [Fibteq Myrel Enterprise License](ee/LICENSE).
  The core must never import from `ee/`.

## Code of Conduct

Everyone taking part in this project follows the
[Code of Conduct](CODE_OF_CONDUCT.md).
