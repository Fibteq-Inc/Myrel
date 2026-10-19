import type { Locale } from "@altair/i18n";
import { useI18n } from "@altair/i18n/react";

const number = (locale: Locale, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options);
const compact = (locale: Locale) => number(locale, { notation: "compact", maximumFractionDigits: 1 });

export function formatTokens(n: number, locale: Locale = "en") {
  return n < 10_000 ? number(locale).format(n) : compact(locale).format(n);
}

/** Micro-dollars as US dollars: cents precision, more for sub-cent amounts. */
export function formatCost(micros: number, locale: Locale = "en") {
  const usd = micros / 1_000_000;
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${number(locale, { maximumFractionDigits: 4 }).format(usd)}`;
  if (usd >= 10_000) return `$${compact(locale).format(usd)}`;
  return `$${number(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(usd)}`;
}

/** "2026-10-19" → "Oct 19" (or "Mon, Oct 19" when long). Dates are already local calendar days. */
export function formatDay(date: string, long = false, locale: Locale = "en") {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString(locale, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(long && { weekday: "short" }),
  });
}

/** The formatters above in the user's language. */
export function useFormat() {
  const { locale } = useI18n();
  return {
    tokens: (n: number) => formatTokens(n, locale),
    cost: (micros: number) => formatCost(micros, locale),
    day: (date: string, long = false) => formatDay(date, long, locale),
  };
}
