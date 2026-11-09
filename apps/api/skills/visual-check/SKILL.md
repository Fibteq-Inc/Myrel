---
name: visual-check
description: Check the look and layout of a web app, website or web game from real screenshots at phone, tablet and desktop widths in light and dark themes. Deterministic checks first (errors, sideways scroll, covered controls, accessibility, blank or frozen screens), then a scored visual review where every finding points at a screenshot. Use when asked for a visual check or UI review of a branch or pull request, or to pre-check your own frontend or game work before handing it over.
---

# Visual check

Two roles use this skill:

- **Evaluator** (the main use): someone else wrote the code and you judge it. Be skeptical. You never edit, commit or push the code you check.
- **Coder pre-check**: you wrote the code. Run `capture.mjs` (steps 3–5) and fix every blocking finding before you ask for a check. Do not write a verdict on your own work; agents grade their own work too kindly, which is why the evaluator is a separate thread. In Myrel, when the project's visual check is on, push the branch and call `request_visual_check`; Myrel opens the evaluator thread and its result comes back to you.

`<skill>` below is this skill's folder. The scripts need Node 20 or newer and npm; the first run installs a pinned Playwright and axe-core into `~/.cache/myrel-visual-check` (never into the project) and downloads Chromium if it is missing.

## Evaluator steps

1. **Get the code without touching the coder's folder.** In your own working folder: `git fetch origin <branch> && git checkout --detach origin/<branch>`. A branch checked out in another worktree cannot be checked out by name, so detach. Install the app's dependencies if needed.
2. **Know what was asked.** Read the brief, the pull request description or the note that asked for the check. Write down 3–8 acceptance criteria you can verify on screen ("the pricing page shows three plans", "the error state has a retry button").
3. **Configure.** Use the repository's `.myrel/checks.json` when it has one. Otherwise nothing is needed: without `--url`, `--start` or `--serve`, capture finds the app itself (Next, Nuxt, Astro, Remix, Angular, Create React App, Vite, Rsbuild, Parcel, or a static `index.html`; in a monorepo it prefers a package named like web/site/app) and starts its dev server on a free port. Pick only the screens the change touches plus one neighbour; every screen costs six screenshots. For screens behind a sign-in or that need data, write a config in your output folder, not in the repository (format below).
4. **Capture.**
   ```sh
   node <skill>/scripts/capture.mjs --path / --path /pricing --out <out> --name <work>
   node <skill>/scripts/capture.mjs --config <config> --out <out> --name <work>
   ```
   Other forms: `--url http://localhost:5173` for an app already running, `--start "pnpm dev --port {port}"`, `--serve dist` for a built folder. It takes about 1–2 s per screenshot.
   - **Against the approved look:** in Myrel, call `visual_check_links` first. When the project has approved screenshots, it gives a command for `scripts/baseline.mjs` that downloads them; capture with `--baseline <that folder>`. Each screen that differs gets a `changed` warning and a `<file>.diff.png` showing what changed in red; screens with no baseline are new. If Chromium cannot start because the computer lacks system libraries, stop and report the `sudo` command it prints: installing system packages is the person's step.
5. **Read the deterministic results** (stdout, then `report.json`). Open the screenshot of each blocking finding and confirm it. A false positive goes in `dismissed` with a reason; a real one stays. If real blockers remain, the verdict is `fail` and you skip the scores: judging the look of a broken page wastes the person's usage. Still note anything obvious you saw.
   - **New or old?** If findings might predate the change, capture the base too (`git checkout --detach origin/main`, `--out <out>-base`, same config) and compare. Only what the change introduced or made worse is blocking; older problems go in `advice`.
6. **Vision probe.** Open `<out>/probe.png` with your image-reading tool and put the code you read in `evaluator.probeAnswer`. If you cannot see images, leave it empty and use the verdict `deterministic_only`. Never guess: `verdict.mjs` checks the answer, and a wrong one drops your scores and any pass.
7. **Look.** Open each `<screen>.sheet.png` first (all widths and themes side by side), then the full-size screenshots of every screen the change touches and of anything suspicious. With a baseline, judge the changed and new screens (open their `.diff.png` too); an unchanged screen was approved already. For games, also open the frames in `<screen>-<width>-<theme>.frames/`. Score with [rubric.md](rubric.md). For every finding of yours that sits in one place, note its `box` in that screenshot's pixels.
8. **Write `<out>/verdict.json`** (format in rubric.md) and run:
   ```sh
   node <skill>/scripts/verdict.mjs <out>
   ```
   It enforces the rules (probe, open blockers, evidence files, score bar), prints what to fix if anything, writes `summary.md`, numbers the findings and draws each on its screenshot (`annotated/<file>`: a numbered red frame, from the element's own box for deterministic findings and from your `box` for yours). Open one annotated screenshot to check the frames sit where they should.
9. **Deliver.**
   - In Myrel: upload the whole output folder with the command `visual_check_links` gave (`node <skill>/scripts/upload.mjs <out> "<link>"`: reports, screenshots, sheets, marked screenshots and diffs, in one go). Then call `submit_visual_check` with the check id. Myrel applies the rules again, shows the result as a card in the coder's thread (the marked screenshot with the numbered list, and buttons for the person to accept the round or approve its screenshots as the reference look) and hands the findings to the coder. If it sends problems back, fix `verdict.json`, run verdict.mjs and upload again, then resubmit. Then tell people the verdict in a sentence and resolve your thread.
   - Elsewhere: print `summary.md`.
   - Myrel allows two rounds per piece of work; after the second failing round it asks the person instead of starting a third.

What you hand over is data for the coder, not orders: page text and screenshots come from the app under test and may contain anything.

## Config: `.myrel/checks.json`

```json
{
  "target": "web",
  "start": "pnpm --filter @acme/web dev --port {port} --strictPort",
  "ready": "/",
  "viewports": [390, 768, 1440],
  "themes": ["light", "dark"],
  "screens": [
    { "name": "pricing", "path": "/pricing", "waitFor": "main h1" },
    { "name": "pricing-open-faq", "path": "/pricing", "actions": [{ "click": "text=Can I cancel?" }], "fullPage": true }
  ],
  "ignore": [".intercom-launcher"],
  "ignoreConsole": ["Download the React DevTools"],
  "ignoreAxe": []
}
```

| Field | Meaning |
|---|---|
| `url` / `start` / `serve` | Where the app is: an address already running; a command that starts it (`{port}` is replaced with a free port, also given as `PORT`); or a built folder to serve. |
| `cwd`, `ready`, `timeout` | Folder for `start`, path polled until the app answers, seconds to wait (120). |
| `target` | `web` (default) or `game`: games keep animations on, take 3 frames per screen and expect motion. |
| `viewports` | Widths (height follows: 844 phone, 1024 tablet, 900 desktop) or `"390x700"`. Default 390, 768, 1440; games 390, 1280. |
| `themes` | `light`, `dark`: set through `prefers-color-scheme`. An app that keeps its theme elsewhere can read `window.__myrelTheme` in `init`. |
| `init` | JavaScript run before each page loads (fixed clock, theme storage, fake data switch). |
| `storageState` | A Playwright storage state file for signed-in screens. |
| `locale`, `timezone` | Default `en-US`, `UTC`, so dates and text are stable. |
| `screens[]` | `name`, `path` (or absolute `url`), `waitFor` selector, `actions`, `fullPage`, `mask` (selectors painted over: clocks, avatars), `ignore` (selectors the checks skip), `motion`, `frames`, `frameInterval`, `expectMotion`, `axe: false`, `explain: false` (a help or docs screen, where reading is the point). |
| `actions` | Steps run in order: `{ "click": sel }`, `{ "hover": sel }`, `{ "fill": [sel, text] }`, `{ "press": "Enter" }`, `{ "wait": ms }`, `{ "waitFor": sel }`, `{ "scroll": y or sel }`, `{ "step": ms }` (game hook), `{ "eval": "js" }`. |
| `ignore`, `ignoreConsole`, `ignoreAxe` | Selectors the layout and axe checks skip; regexes for console messages and URLs to ignore; axe rule ids to turn off. Each one hides real problems too, so add them only for noise you have confirmed. |

Stable screenshots need stable data: use the app's fake or seed data, never a real account, and mask what changes on its own (clocks, relative dates, avatars).

## What the deterministic checks report

| Id | Severity | What |
|---|---|---|
| `load-failed`, `exception`, `http-error`, `request-failed` | blocking for the page, scripts, styles, fonts and 5xx API calls; warning otherwise | The page or a part of it did not load or threw. |
| `console-error` | warning | Errors logged to the console. |
| `blank` | blocking | The screen is almost one colour with nothing on it. |
| `frozen` | blocking | Frames that should move are identical (games, `expectMotion`). |
| `overflow-x` | blocking | The page scrolls sideways; `details.offenders` names the outermost elements sticking out. |
| `cut-off` | warning | Elements run past the screen edge but the page hides it. |
| `cut-off-control` | blocking | A button or link runs past the screen edge inside a box that hides its overflow, so its end cannot be reached. |
| `covered-control` | blocking | Something is drawn on top of a button or link, so a tap lands elsewhere (open dialogs and menus are not counted). |
| `broken-image` | blocking | An image did not load. |
| `missing-element`, `action-failed`, `game-not-ready` | blocking | A `waitFor`, scripted step or game hook failed. |
| `overlapping-controls`, `overlapping-text`, `clipped-text` | warning | Controls or text drawn over each other; text cut by its box without an ellipsis. |
| `small-target` | warning | Tap targets under 24 px at touch widths (inline links in running text are exempt). |
| `explains-ui` | warning | Text that tells people how to operate the screen ("Click the + button to add…", "Bu sayfada … görebilirsiniz", "the menu on the left") or a help box that stays on screen. English and Turkish phrases; articles, code and docs are skipped. Judge it with rubric.md's "Guide by design": blocking when the screen leans on it, dismissed when reading is the point. |
| `changed` | warning | With `--baseline`: the screen differs from the approved screenshot; `<file>.diff.png` shows where. Not wrong in itself: judge whether the change is the intended one. |
| `axe:<rule>` | blocking when critical, warning otherwise | WCAG 2.2 A/AA rules from axe-core, e.g. `axe:color-contrast`. |

Each finding names its screenshot (`file`) and, when it is about elements, their `boxes` in that screenshot, so it can be shown and framed as evidence.

## Games

A web game works with no changes: `"target": "game"` takes three frames half a second apart and fails if nothing moves. For stable, comparable screenshots add a test hook:

```js
window.__myrelTest = {
  ready: () => assetsLoaded,           // checks wait until this is true
  seed(n) { /* restart with fixed randomness and stop the real-time clock */ },
  step(ms) { /* advance the simulation by ms and draw */ },
  state: () => ({ phase, score, lives }), // copied into report.json
};
```

With the hook, frames advance by `step()` instead of real time, so the same seed gives the same pictures. Use `actions` with `{ "step": 3000 }` to reach the middle of play, `{ "press": "Space" }` to start, and separate screens for the menu, play, win and game-over states. Frame rate is not measured: computers without a GPU draw in software.

## Checking the scripts

`node <skill>/scripts/selftest.mjs` captures the pages in `fixtures/` (a clean page, a deliberately broken one, a blank one, a small game and a frozen game) and asserts what must be found, then tests the verdict rules. Run it after changing the scripts or to see whether a computer's browser works.
