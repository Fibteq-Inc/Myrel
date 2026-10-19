const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en");

export function formatTokens(n: number) {
  return n < 10_000 ? whole.format(n) : compact.format(n);
}

/** Micro-dollars as US dollars: cents precision, more for sub-cent amounts. */
export function formatCost(micros: number) {
  const usd = micros / 1_000_000;
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4).replace(/0+$/, "")}`;
  if (usd >= 10_000) return `$${compact.format(usd)}`;
  return `$${usd.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "2026-10-19" → "Oct 19" (or "Mon, Oct 19" when long). Dates are already local calendar days. */
export function formatDay(date: string, long = false) {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(long && { weekday: "short" }),
  });
}
