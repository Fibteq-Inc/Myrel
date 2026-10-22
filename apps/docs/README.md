# Myrel docs

The user guide at https://docs.myrel.fibteq.io, built with [Astro Starlight](https://starlight.astro.build).
It covers using Myrel. Running, building and contributing stay in the repository's own docs
(README, `docs/`, CONTRIBUTING); the guide links to them instead of repeating them.

```sh
pnpm --filter @myrel/docs dev       # http://localhost:4321
pnpm --filter @myrel/docs build     # static site in dist/
pnpm --filter @myrel/docs deploy    # build and upload to the myrel-docs Worker (static assets only)
```

Pages are Markdown in `src/content/docs/`; the sidebar is in `astro.config.mjs`.

## Screenshots

The pictures in `src/assets/screenshots/` come from a local Myrel filled with made-up data, so they
never show a real project. `scripts/screenshots.mjs` plays the model and the computer itself: the
coordinator's model is a scripted OpenAI-compatible server and the thread agent is a fake
myrel-runner that answers through Myrel's tools.

1. Set up the local stack as in the README's quick start, and in `apps/api/.dev.vars` point the
   model at the script's fake:

   ```sh
   LLM_PROVIDER=openai
   LLM_BASE_URL=http://localhost:9911/v1
   LLM_MODEL=claude-sonnet-5-5
   OPENAI_API_KEY=docs-screenshots
   ```

2. Run `pnpm dev` from the repository root (or the API with `wrangler dev --enable-containers=false`
   if Docker is not running).
3. Run `pnpm --filter @myrel/docs screenshots`. It uses Playwright's Chromium when installed
   (`pnpm --filter @myrel/docs exec playwright install chromium`), else your installed Chrome.

Each run signs up a new made-up user, so the local database can be reused. After a UI change,
run it again and commit the new pictures with the change.
