import type { Locale } from "@myrel/i18n";
import { useI18n } from "@myrel/i18n/react";

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

/** "now", "5 minutes ago", "in 3 hours", "Oct 19": for notification and schedule times. */
export function formatRelative(iso: string, locale: Locale = "en", now = Date.now()) {
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return relative.format(0, "second");
  if (abs < 3600_000) return relative.format(Math.round(diff / 60_000), "minute");
  if (abs < 86400_000) return relative.format(Math.round(diff / 3600_000), "hour");
  if (abs < 7 * 86400_000) return relative.format(Math.round(diff / 86400_000), "day");
  return new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** A local date and time, e.g. "Mon, Oct 20, 09:00". */
export function formatDateTime(iso: string, locale: Locale = "en") {
  return new Date(iso).toLocaleString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** A weekday's name, 0 = Sunday. */
export function formatWeekday(day: number, locale: Locale = "en") {
  // 2026-10-18 was a Sunday.
  return new Date(Date.UTC(2026, 9, 18 + (day % 7))).toLocaleDateString(locale, { weekday: "long", timeZone: "UTC" });
}

/** The formatters above in the user's language. */
export function useFormat() {
  const { locale } = useI18n();
  return {
    tokens: (n: number) => formatTokens(n, locale),
    cost: (micros: number) => formatCost(micros, locale),
    day: (date: string, long = false) => formatDay(date, long, locale),
    relative: (iso: string) => formatRelative(iso, locale),
    dateTime: (iso: string) => formatDateTime(iso, locale),
    weekday: (day: number) => formatWeekday(day, locale),
  };
}
