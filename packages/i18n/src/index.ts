import { en } from "./locales/en";
import { tr } from "./locales/tr";

/**
 * A message with plural forms, picked by `count` through Intl.PluralRules.
 * `other` is required; add the forms a language needs (`one`, `few`, ...).
 */
export type PluralMessage = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;

/** English is the source catalog: its keys and shapes are the contract every language fills. */
export type Catalog = { [K in keyof typeof en]: (typeof en)[K] extends string ? string : PluralMessage };
export type MessageKey = keyof Catalog;
export type Params = Record<string, string | number>;

export const LOCALES = ["en", "tr"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const catalogs: Record<Locale, Catalog> = { en, tr };

/** Each language's name in itself, for the language switcher. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", tr: "Türkçe" };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * The first supported language among the user's preferences, e.g.
 * `navigator.languages` on the web or the device locales on mobile.
 * "tr-TR" matches "tr".
 */
export function matchLocale(preferred: readonly string[] | undefined): Locale {
  for (const tag of preferred ?? []) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

export type Translate = (key: MessageKey, params?: Params) => string;

/**
 * A `t` for one language. `{name}` in a message is replaced from `params`;
 * a plural message picks its form by `params.count`. A key missing from the
 * catalog falls back to English.
 */
export function createTranslator(locale: Locale): Translate {
  const catalog = catalogs[locale];
  // Hermes (the React Native engine) has no Intl.PluralRules; English and Turkish both only
  // distinguish "one" from "other", so that rule covers every locale we ship.
  const plurals: Pick<Intl.PluralRules, "select"> =
    typeof Intl.PluralRules === "function"
      ? new Intl.PluralRules(locale)
      : { select: (n) => (n === 1 ? "one" : "other") };
  return (key, params) => {
    const message = catalog[key] ?? en[key];
    const text =
      typeof message === "string" ? message : (message[plurals.select(Number(params?.count ?? 0))] ?? message.other);
    return interpolate(text, params);
  };
}

function interpolate(text: string, params?: Params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** "now", "5m", "3h", "2d", then a short date, in the given language. */
export function relativeTime(t: Translate, locale: Locale, iso: string, now = Date.now()) {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return t("time.now");
  if (s < 3600) return t("time.minutes", { count: Math.floor(s / 60) });
  if (s < 86400) return t("time.hours", { count: Math.floor(s / 3600) });
  if (s < 7 * 86400) return t("time.days", { count: Math.floor(s / 86400) });
  return new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** The local calendar day a time falls on, e.g. "2026-10-26": for grouping by day. */
export function localDay(at: string | number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "Today", "Yesterday", then a date ("Fri, Oct 24", with the year when it is not this year). */
export function dayLabel(t: Translate, locale: Locale, at: string | number, now = Date.now()) {
  const day = localDay(at);
  if (day === localDay(now)) return t("time.today");
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === localDay(yesterday.getTime())) return t("time.yesterday");
  const d = new Date(at);
  return d.toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== new Date(now).getFullYear() && { year: "numeric" }),
  });
}

/** The local clock time, e.g. "14:32". */
export function clockTime(locale: Locale, at: string | number) {
  return new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
}
