import { isLocale, type Locale, matchLocale } from "@myrel/i18n";

const KEY = "myrel.locale";

/** The saved choice, else the browser's languages, else English. */
export function initialLocale(): Locale {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // Private mode: fall through to the browser's languages.
  }
  const locale = isLocale(saved) ? saved : matchLocale(navigator.languages);
  document.documentElement.lang = locale;
  return locale;
}

export function saveLocale(locale: Locale) {
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(KEY, locale);
  } catch {
    // Private mode: the choice lasts until reload.
  }
}
