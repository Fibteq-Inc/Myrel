# Notes for coding agents

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and conventions.

## Checks before pushing

- Run `pnpm check:changed`, not `pnpm typecheck` and `pnpm test`. It type-checks and tests only the
  packages your branch changes and the ones that depend on them, the same set pull request CI checks.
  The full test run takes about two minutes on an idle machine (most of it `@myrel/api`), long enough
  to hit a command timeout; leave it to CI.
- While working on `apps/api`, `pnpm --filter @myrel/api exec vitest run --changed main` runs only the
  test files that import what you changed.
- If CI fails on the pull request, fix it on the same branch.
