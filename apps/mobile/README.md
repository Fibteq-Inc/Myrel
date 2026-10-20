# Altair mobile

The Altair app for iOS and Android, built with [Expo](https://expo.dev) (SDK 58, Expo Router).
It shares the API client, WebSocket sync and project state with the web app through
`packages/client`, so only the screens live here.

What it does:

- Connects to any Altair server (hosted or self-hosted). The address is checked with
  `GET /api/info`, and sign-ins are kept per server in the iOS Keychain / Android Keystore.
- Signs in with email and password and talks to the API with a bearer token (no cookies).
- The same project tabs as the web app: Conversation, Threads, Artifacts, Files and Usage.
  Threads show the agent's plan as a live checklist; replies show where they ran, the model,
  time, tokens and cost.
- English and Turkish, from the shared `@altair/i18n` catalog: the device language by default,
  changeable on the sign-in screen and in Settings.
- Decision cards answered with one tap: the chosen option is sent as your reply.
- Links in messages, artifacts above all, open in an in-app WebView.
- Push notifications: registers the device's Expo push token at `POST /api/notifications/subscriptions`,
  and tapping a notification opens its project or thread (`data: { projectId, threadId }`).
  The live socket closes in the background and catches up by `seq` when the app returns.

## Run it

```sh
pnpm install
pnpm --filter @altair/mobile dev     # then press i / a, or scan the QR code with Expo Go
```

To start on a server without typing it in, set `EXPO_PUBLIC_ALTAIR_SERVER=https://altair.example.com`.
Against a local API (`pnpm dev` in `apps/api`), use your machine's LAN address, e.g.
`http://192.168.1.20:8787`.

Push notifications need a physical device and an EAS project (below). Without one the app
works the same, just without pushes.

## Builds (EAS)

Mobile builds are separate from the Cloudflare deploy. One-time setup, done by the account owner:

1. Create an [Expo account](https://expo.dev/signup) and run `npx eas-cli login`.
2. In `apps/mobile`, run `npx eas-cli init` and put the project id it prints in
   `EAS_PROJECT_ID` (and your Expo account or organization in `EAS_OWNER`), e.g. as EAS
   environment variables.
3. iOS: an Apple Developer account. EAS creates the certificates and the push key
   (`npx eas-cli credentials`).
4. Android: a Firebase project's FCM V1 service account key, uploaded with `npx eas-cli credentials`.

Then:

```sh
npx eas-cli build --profile development --platform all   # dev client for testing
npx eas-cli build --profile production --platform all
npx eas-cli submit --platform ios                        # TestFlight / App Store
```

The bundle id / package is `io.fibteq.altair` and the deep link scheme is `altair://`.
The API trusts the `altair://` origin the app sends (see `apps/api/src/origins.ts`).
