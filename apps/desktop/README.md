# Altair desktop

The Altair desktop app for macOS, Windows and Linux, built with [Tauri 2](https://tauri.app). The UI is
`apps/web`; this package wraps it and injects a desktop `Platform` (see `packages/client/src/platform.ts`)
before the app loads:

| Need | Desktop implementation |
| --- | --- |
| Sign-in tokens | OS keychain (`secret_get` / `secret_set` in `src-tauri/src/secrets.rs`), one entry per server |
| Settings (chosen server) | `settings.json` in the app data folder (`@tauri-apps/plugin-store`) |
| Notifications | native notifications |
| File picker | native open dialog |
| Links | opened in the default browser |
| `altair://` links | `altair://connect?server=https://altair.example.com` switches server after a confirmation; any other path opens that page, e.g. `altair://projects/<id>` |
| Updates | checks GitHub releases at startup and offers to install |
| Local folders | the bundled `altair-runner` (see below) |

The app is not tied to one server: on first launch it asks for an Altair address (hosted or self-hosted)
and checks it with `GET /api/info`. A build can preselect a server with `VITE_API_URL`; release builds
default to `https://altair.fibteq.io` (repository variable `ALTAIR_DESKTOP_API_URL` overrides it).

## Bundled altair-runner

`packages/altair-runner` ships inside the app as a Tauri sidecar, compiled to one executable with
`bun build --compile` (`scripts/build-runner.mjs`, run before every `tauri dev` / `tauri build`). On the
Devices page, **Connect this computer** pairs it in one click: the app asks the server for a pairing code,
trades it for a runner login and keeps that login in the OS keychain. The runner gets it through
`ALTAIR_SERVER` / `ALTAIR_RUNNER_TOKEN` and never writes it to disk. It runs while the app is open, starts
again at the next launch, and gets the login shell's `PATH` so it finds `claude`, `codex` and `gemini`.
Folders are shared from the Devices page like for any other computer; they live in the app data folder
(`runner/config.json`), separate from a terminal `npx altair-runner` install.

## Develop

Install the [Tauri prerequisites](https://tauri.app/start/prerequisites/) (Rust, plus WebKitGTK on Linux) and
[Bun](https://bun.sh) (to compile the runner), then:

```sh
pnpm install
pnpm --filter @altair/desktop dev                                  # opens the app; asks for a server
VITE_API_URL=http://localhost:8787 pnpm --filter @altair/desktop dev   # against a local `pnpm dev` API
pnpm --filter @altair/desktop bundle                               # installers in src-tauri/target/release/bundle
```

Regenerate icons from `icon.svg` with `pnpm --filter @altair/desktop icons`.

## Release

`.github/workflows/desktop.yml` builds every pull request that touches the app and uploads the
installers as workflow artifacts. To publish, bump `version` in `src-tauri/Cargo.toml`, then push a tag
with the same version:

```sh
git tag desktop-v0.1.0 && git push origin desktop-v0.1.0
```

The workflow creates a draft GitHub release with the installers and, when the updater key is set,
`latest.json` for in-app updates. Publishing the draft makes it live.

The updater downloads from public GitHub release URLs, so it only works once the repository is public
(or after pointing `plugins.updater.endpoints` in `src-tauri/tauri.conf.json` at public storage such as R2).

### Signing secrets

Builds run without these, but unsigned. Add them under the repository's Settings → Secrets and variables → Actions.

**Updater (needed for auto-update):**

1. Run `pnpm --filter @altair/desktop tauri signer generate -w ~/.tauri/altair.key` and keep the key safe.
2. Secret `TAURI_SIGNING_PRIVATE_KEY`: contents of `~/.tauri/altair.key`.
3. Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password you chose.
4. Variable `TAURI_UPDATER_PUBKEY`: contents of `~/.tauri/altair.key.pub`.

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
