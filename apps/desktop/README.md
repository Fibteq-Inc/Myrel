# Myrel desktop

The Myrel desktop app for macOS, Windows and Linux, built with [Tauri 2](https://tauri.app). The UI is
`apps/web`; this package wraps it and injects a desktop `Platform` (see `packages/client/src/platform.ts`)
before the app loads:

| Need | Desktop implementation |
| --- | --- |
| Sign-in tokens | OS keychain (`secret_get` / `secret_set` in `src-tauri/src/secrets.rs`), one entry per server |
| Settings (chosen server) | `settings.json` in the app data folder (`@tauri-apps/plugin-store`) |
| Notifications | native notifications |
| File picker | native open dialog |
| Links | opened in the default browser |
| `myrel://` links | `myrel://connect?server=https://myrel.example.com` switches server after a confirmation; any other path opens that page, e.g. `myrel://projects/<id>` |
| Updates | checks GitHub releases at startup and offers to install |
| Local folders | the bundled `myrel-runner` (see below) |

The app is not tied to one server: on first launch it asks for an Myrel address (hosted or self-hosted)
and checks it with `GET /api/info`. A build can preselect a server with `VITE_API_URL`; release builds
default to `https://myrel.fibteq.io` (repository variable `MYREL_DESKTOP_API_URL` overrides it).

## Bundled myrel-runner

`packages/myrel-runner` ships inside the app as a Tauri sidecar, compiled to one executable with
`bun build --compile` (`scripts/build-runner.mjs`, run before every `tauri dev` / `tauri build`). On the
Devices page, **Connect this computer** pairs it in one click: the app asks the server for a pairing code,
trades it for a runner login and keeps that login in the OS keychain. The runner gets it through
`MYREL_SERVER` / `MYREL_RUNNER_TOKEN` and never writes it to disk. It runs while the app is open, starts
again at the next launch, and gets the login shell's `PATH` so it finds `claude`, `codex` and `gemini`.
Folders are shared from the Devices page like for any other computer; they live in the app data folder
(`runner/config.json`), separate from a terminal `npx myrel-runner` install.

## Develop

Install the [Tauri prerequisites](https://tauri.app/start/prerequisites/) (Rust, plus WebKitGTK on Linux) and
[Bun](https://bun.sh) (to compile the runner), then:

```sh
pnpm install
pnpm --filter @myrel/desktop dev                                  # opens the app; asks for a server
VITE_API_URL=http://localhost:8787 pnpm --filter @myrel/desktop dev   # against a local `pnpm dev` API
pnpm --filter @myrel/desktop bundle                               # installers in src-tauri/target/release/bundle
```

Regenerate icons from `icon.svg` with `pnpm --filter @myrel/desktop icons`.

## Release

Releases start by hand: Actions → Release → Run workflow, app `desktop`, and the version step (`patch`,
`minor` or `major` from the latest `desktop-v*` tag). The workflow (`.github/workflows/release.yml`) tags the
tip of main, opens a draft release with GitHub's generated notes (pull requests labelled `app:desktop` since
the previous desktop tag, `.github/release-desktop.yml`), runs `.github/workflows/desktop.yml` to attach the
signed installers and `latest.json`, and publishes the release once every platform built. The version comes
from the tag; `package.json` and `src-tauri/Cargo.toml` aren't bumped.

A release drafted by hand in the GitHub UI (tag `desktop-vx.y.z` on main, "Generate release notes") works
too: publishing it starts the build.

If one platform fails, the release stays a draft. Fix the cause on main and rebuild it with a manual run
(Actions → Desktop → Run workflow on main, with the tag): it builds the tagged commit and replaces the
release's installers. Then publish the draft.

Manual runs without a tag (Actions → Desktop → Run workflow on main) upload the installers as workflow
artifacts. Pull requests don't build the app; CI's typecheck and build cover its TypeScript.

While the repository is private, macOS builds on the org's self-hosted Mac runner (labels `self-hosted`,
`macOS`), so that Mac must be on and awake while a release builds. Once the repository is public, it uses
GitHub's hosted runners.

When the updater key is set, the release also gets `latest.json`, which installed apps check for updates
through the latest release, so only desktop releases are marked latest.

The updater downloads from public GitHub release URLs, so it only works once the repository is public
(or after pointing `plugins.updater.endpoints` in `src-tauri/tauri.conf.json` at public storage such as R2).

### Signing secrets

Builds run without these, but unsigned. Add them under the repository's Settings → Secrets and variables → Actions.

**Updater (needed for auto-update):**

1. Run `pnpm --filter @myrel/desktop tauri signer generate -w ~/.tauri/myrel.key` and keep the key safe.
2. Secret `TAURI_SIGNING_PRIVATE_KEY`: contents of `~/.tauri/myrel.key`.
3. Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password you chose.
4. Variable `TAURI_UPDATER_PUBKEY`: contents of `~/.tauri/myrel.key.pub`.

**macOS (Apple Developer Program, $99/year):**

- `APPLE_CERTIFICATE`: a "Developer ID Application" certificate exported as `.p12`, base64-encoded (`base64 -i cert.p12`).
- `APPLE_CERTIFICATE_PASSWORD`: the `.p12` export password.
- `APPLE_SIGNING_IDENTITY`: e.g. `Developer ID Application: Fibteq (TEAMID)`.
- `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password from appleid.apple.com), `APPLE_TEAM_ID`: for notarization.

**Windows:** unsigned installers work but show a SmartScreen warning. Code-signing certificates now live on
hardware or in a cloud HSM, so signing goes through `bundle.windows.signCommand` with a cloud signing
service (Azure Artifact Signing, SSL.com eSigner, Certum and similar). Once one is chosen, its CLI and
credentials are added to the workflow.

**Linux:** no signing needed.
