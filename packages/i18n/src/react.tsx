import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { createTranslator, DEFAULT_LOCALE, type Locale, type Translate } from "./index";

type I18n = { locale: Locale; setLocale: (locale: Locale) => void; t: Translate };

const I18nContext = createContext<I18n>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: createTranslator(DEFAULT_LOCALE),
});

/**
 * Holds the current language for the app. The app decides the first one
 * (saved choice, else device languages) and saves changes in `onChange`, so
 * web and React Native can each use their own storage.
 */
export function I18nProvider({
  initialLocale,
  onChange,
  children,
}: {
  initialLocale: Locale;
  onChange?: (locale: Locale) => void;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState(initialLocale);
  const value = useMemo<I18n>(
    () => ({
      locale,
      t: createTranslator(locale),
      setLocale: (next) => {
        setLocaleState(next);
        onChange?.(next);
      },
    }),
    [locale, onChange],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** `t`, the current language, and a way to change it. */
export function useI18n() {
  return useContext(I18nContext);
}

/** Just `t`. */
export function useT() {
  return useContext(I18nContext).t;
}
