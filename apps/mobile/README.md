# Myrel mobile

The Myrel app for iOS and Android, built with [Expo](https://expo.dev) (SDK 58, Expo Router).
It shares the API client, WebSocket sync and project state with the web app through
`packages/client`, so only the screens live here.

What it does:

- Connects to any Myrel server (hosted or self-hosted). The address is checked with
  `GET /api/info`, and sign-ins are kept per server in the iOS Keychain / Android Keystore.
- Signs in with email and password and talks to the API with a bearer token (no cookies).
- The same project tabs as the web app: Conversation, Threads, Artifacts, Files and Usage.
  Threads show the agent's plan as a live checklist; replies show where they ran, the model,
  time, tokens and cost.
- English and Turkish, from the shared `@myrel/i18n` catalog: the device language by default,
  changeable on the sign-in screen and in Settings.
- Decision cards answered with one tap: the chosen option is sent as your reply.
- Links in messages, artifacts above all, open in an in-app WebView.
- Push notifications: registers the device's Expo push token at `POST /api/notifications/subscriptions`,
  and tapping a notification opens its project or thread (`data: { projectId, threadId }`).
  The live socket closes in the background and catches up by `seq` when the app returns.

## Run it

```sh
pnpm install
pnpm --filter @myrel/mobile dev     # then press i / a, or scan the QR code with Expo Go
```

To start on a server without typing it in, set `EXPO_PUBLIC_MYREL_SERVER=https://myrel.example.com`.
Against a local API (`pnpm dev` in `apps/api`), use your machine's LAN address, e.g.
`http://192.168.1.20:8787`.

Push notifications need a physical device and an EAS project (below). Without one the app
works the same, just without pushes.

## Builds (EAS)

Mobile builds are separate from the Cloudflare deploy. One-time setup, done by the account owner:

1. Create an [Expo account](https://expo.dev/signup) and run `npx eas-cli login`.
2. The hosted app is already linked to `@fibteqs-organization/myrel` in `app.config.ts`.
   For your own build, run `npx eas-cli init` in `apps/mobile` and set `EAS_PROJECT_ID` and
   `EAS_OWNER` to the project id and account it prints (dynamic config can't be written by
   `eas init` itself).
3. iOS: an Apple Developer account. EAS creates the certificates and the push key
   (`npx eas-cli credentials`).
4. Android: a Firebase project with an Android app `io.fibteq.myrel`. Upload its FCM V1
   service account key with `npx eas-cli credentials`, and give builds its `google-services.json`:
   `npx eas-cli env:create --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --visibility secret --environment production --environment preview --environment development`.

Then:

```sh
npx eas-cli build --profile development --platform all   # dev client for testing
npx eas-cli build --profile production --platform all
npx eas-cli submit --platform ios                        # TestFlight / App Store
```

The bundle id / package is `io.fibteq.myrel` and the deep link scheme is `myrel://`.
The API trusts the `myrel://` origin the app sends (see `apps/api/src/origins.ts`).

## Releases

JavaScript-only changes reach installed apps as EAS Updates: every push to `main` that touches the app
runs `.github/workflows/mobile-update.yml`, which publishes an update for each platform with `eas update`.
`runtimeVersion` uses the fingerprint policy, so an update only reaches store builds with the same native
fingerprint; a change that needs a new store build reaches users with that build instead.

Store versions start by hand: Actions → Release → Run workflow, app `mobile`, and the version step. The
workflow (`.github/workflows/release.yml`) tags the tip of main `mobile-vX.Y.Z`, publishes a GitHub
release with the generated notes (pull requests labelled `app:mobile`, `.github/release-mobile.yml`) and
runs `.github/workflows/mobile.yml`: production builds on GitHub's runners with `eas build --local` (iOS on
macOS, Android on Linux), so no EAS build credits are used, uploaded with `eas submit` to TestFlight and
Play internal testing. Signing credentials, store keys and build numbers stay on EAS. The tag is the store
version (`app.config.ts` reads it from `MYREL_RELEASE_TAG`); `package.json` isn't bumped. If one platform
fails, rebuild it with Actions → Mobile → Run workflow and the tag. Sending the version for review stays a
manual step in App Store Connect and Play Console. Release whenever a native change (a new native module,
config plugin or permission) is on `main`, since those can't ship as an update.

Both workflows need two secrets in the repository's `store` environment (Settings → Environments, limited
to `main`): `EXPO_TOKEN`, an Expo robot user's token with access to the project, and
`GOOGLE_SERVICES_JSON`, the content of `google-services.json` (EAS keeps it as a secret variable, which
local builds can't read).

## Store listing

The App Store listing (name, texts, keywords, age rating, review notes and screenshots) lives in
`store.config.js` and goes up with `npx eas-cli metadata:push`. The review contact and demo account
come from `APP_REVIEW_*` environment variables listed at the top of that file, so they stay out of git.
Screenshots are in `store/screenshots/`; the Google Play texts and the privacy and content forms of both
stores are in `store/forms.md`. Store builds open on `https://myrel.fibteq.io` (`EXPO_PUBLIC_MYREL_SERVER`
in `eas.json`).

Pro is sold in the app (Settings > Plan and billing) through RevenueCat when the build has
`EXPO_PUBLIC_REVENUECAT_IOS_KEY` / `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY` and the server has RevenueCat
set up (see `ee/billing/README.md`). Expo Go cannot buy; use a development or store build.
