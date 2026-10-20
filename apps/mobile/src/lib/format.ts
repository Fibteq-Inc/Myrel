import type { Locale, Translate } from "@myrel/i18n";

const number = (locale: Locale, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options);
const compact = (locale: Locale) => number(locale, { notation: "compact", maximumFractionDigits: 1 });

export function formatTokens(n: number, locale: Locale) {
  return n < 10_000 ? number(locale).format(n) : compact(locale).format(n);
}

/** Micro-dollars as US dollars: cents precision, more for sub-cent amounts. */
export function formatCost(micros: number, locale: Locale) {
  const usd = micros / 1_000_000;
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${number(locale, { maximumFractionDigits: 4 }).format(usd)}`;
  if (usd >= 10_000) return `$${compact(locale).format(usd)}`;
  return `$${number(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(usd)}`;
}

export function formatDuration(ms: number, t: Translate, locale: Locale) {
  const s = ms / 1000;
  if (s < 60) return t("duration.seconds", { value: number(locale, { maximumFractionDigits: s < 10 ? 1 : 0 }).format(s) });
  const total = Math.round(s);
  if (total < 3600) return t("duration.minutes", { minutes: Math.floor(total / 60), seconds: total % 60 });
  return t("duration.hours", { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60) });
}

export function formatBytes(n: number, locale: Locale) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${number(locale, { maximumFractionDigits: 1 }).format(n / 1024)} KB`;
  return `${number(locale, { maximumFractionDigits: 1 }).format(n / 1024 / 1024)} MB`;
}

/** "accounts/fireworks/models/kimi-k2p6" reads as "kimi-k2p6". */
export function modelName(model: string) {
  return model.replace(/^accounts\/[^/]+\/models\//, "");
}
