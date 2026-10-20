# @myrel/i18n

UI strings for Myrel, shared by the web app and the mobile app. No
dependencies: a typed catalog per language, `{name}` parameters, plural forms
through `Intl.PluralRules`, and small React bindings.

Languages: English (`en`, the source) and Turkish (`tr`). The web app picks the
saved choice, else the browser's languages, else English; people change it in
Settings → Account, the account menu or the sign-in page.

## Adding a string

1. Add the key to `src/locales/en.ts`, under its area (`thread.resolve`,
   `workspace.terminalEmpty`). Keys are `area.thing`.
2. Add the same key to every other file in `src/locales/`. `pnpm typecheck`
   fails until each language has it, and `pnpm test` checks that every language
   uses the same `{parameters}`.
3. Use it:

   ```tsx
   import { useT } from "@myrel/i18n/react";

   const t = useT();
   <button>{t("thread.resolve")}</button>;
   t("server.current", { host });           // "Server: {host}"
   t("threadCard.replies", { count: 3 });   // plural: { one: "1 reply", other: "{count} replies" }
   ```

   Outside a component (a helper, a tab list), take a `t: Translate` argument
   instead of calling the hook. For times use `useRelativeTime()` from
   `apps/web/src/lib/ui.tsx`.

Rules of thumb:

- Every visible string goes through `t`, including `aria-label`, `title` and
  `placeholder`. Product names (Myrel), code and examples like
  `myrel.example.com` stay as they are.
- Write whole sentences as one message with parameters; never glue pieces
  together, since word order differs between languages.
- If you don't speak a language, add your best translation and say so in the
  PR so someone can check it.

## Adding a language

Add `src/locales/<code>.ts` typed as `Catalog`, then add the code to `LOCALES`,
`catalogs` and `LOCALE_NAMES` in `src/index.ts`.
