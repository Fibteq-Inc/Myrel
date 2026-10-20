import { isLocale, type Locale, matchLocale } from "@myrel/i18n";
import { I18nProvider } from "@myrel/i18n/react";
import { getLocales } from "expo-localization";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { platform } from "./platform";

const LOCALE_KEY = "locale";

/** The saved language, else the first device language Altair speaks, else English. */
async function initialLocale(): Promise<Locale> {
  const saved = await platform.storage.get(LOCALE_KEY);
  if (isLocale(saved)) return saved;
  return matchLocale(getLocales().map((l) => l.languageTag));
}

/** Renders nothing until the language is known, so the first screen never flips language. */
export function AppI18n({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale | null>(null);
  useEffect(() => {
    void initialLocale().then(setLocale);
  }, []);
  const save = useCallback((next: Locale) => void platform.storage.set(LOCALE_KEY, next), []);
  if (!locale) return null;
  return (
    <I18nProvider initialLocale={locale} onChange={save}>
      {children}
    </I18nProvider>
  );
}
