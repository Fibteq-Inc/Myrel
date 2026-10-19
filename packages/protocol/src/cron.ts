/**
 * Minimal five-field cron (minute hour day-of-month month day-of-week) with
 * time zone support, shared by the server (scheduling) and apps (previews).
 * Supports `*`, numbers, ranges `a-b`, steps `x/n` and lists `a,b`. Day of week
 * is 0-7 with 0 and 7 both Sunday. As in classic cron, when both day fields
 * are restricted a day matches if either does.
 */
export type Cron = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
};

const BOUNDS: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("A cron expression has five fields: minute hour day month weekday");
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((p, i) => parseField(p, ...BOUNDS[i]!));
  // Sunday is both 0 and 7.
  if (dayOfWeek!.has(7)) dayOfWeek!.add(0);
  dayOfWeek!.delete(7);
  return {
    minute: minute!,
    hour: hour!,
    dayOfMonth: dayOfMonth!,
    month: month!,
    dayOfWeek: dayOfWeek!,
    anyDayOfMonth: parts[2] === "*",
    anyDayOfWeek: parts[4] === "*",
  };
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [min, max];
    else if (range!.includes("-")) [lo, hi] = range!.split("-").map(Number) as [number, number];
    else {
      lo = Number(range);
      // "5/15" means from 5 to the end in steps of 15.
      hi = stepText === undefined ? lo : max;
    }
    if (![lo, hi, step].every(Number.isInteger) || step < 1 || lo < min || hi > max || lo > hi) {
      throw new Error(`Invalid cron field "${field}" (allowed ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

type LocalFields = { month: number; day: number; weekday: number; hour: number; minute: number };

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function localFields(t: number, timeZone: string): LocalFields {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(t)) parts[p.type] = p.value;
  return {
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAYS[parts.weekday!]!,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

const MINUTE = 60_000;

/** The first moment strictly after `after` that matches `expr` in `timeZone`, or null if none within ~5 years. */
export function nextCronRun(expr: string | Cron, timeZone: string, after: Date): Date | null {
  const cron = typeof expr === "string" ? parseCron(expr) : expr;
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  // Each step jumps to the next day, hour or minute that could match, so this stays small.
  for (let i = 0; i < 20_000; i++) {
    const f = localFields(t, timeZone);
    const domOk = cron.dayOfMonth.has(f.day);
    const dowOk = cron.dayOfWeek.has(f.weekday);
    const dayOk =
      cron.anyDayOfMonth && cron.anyDayOfWeek
        ? true
        : cron.anyDayOfMonth
          ? dowOk
          : cron.anyDayOfWeek
            ? domOk
            : domOk || dowOk;
    if (!cron.month.has(f.month) || !dayOk) t += (24 * 60 - (f.hour * 60 + f.minute)) * MINUTE;
    else if (!cron.hour.has(f.hour)) t += (60 - f.minute) * MINUTE;
    else if (!cron.minute.has(f.minute)) t += MINUTE;
    else return new Date(t);
  }
  return null;
}
