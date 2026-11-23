import { useT } from "@myrel/i18n/react";
import type { UsageMetric, UsageSeries } from "@myrel/client";
import { useLayoutEffect, useRef, useState } from "react";
import { useFormat } from "../lib/format";

/** A series' color token; the ones without a color of their own share a neutral. */
export function seriesColor(slot: number | null): string {
  return slot === null ? "var(--color-subtle)" : `var(--chart-${slot})`;
}

const HEIGHT = 220;
const PAD = { top: 12, right: 8, bottom: 26, left: 52 };
const GAP = 2;
const HOUR_MS = 3_600_000;

/** Stacked daily bars, one color per series. Hover or focus a day for its numbers. */
export function UsageChart({
  days,
  series,
  metric,
  names,
}: {
  /** YYYY-MM-DD, oldest first; the series' values follow them. */
  days: string[];
  series: UsageSeries[];
  metric: UsageMetric;
  /** What each series is called. */
  names: string[];
}) {
  const t = useT();
  const { tokens: formatTokens, cost: formatCost, number: formatNumber, day: formatDay } = useFormat();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const totals = days.map((_, i) => series.reduce((sum, s) => sum + s.values[i]!, 0));
  const most = Math.max(0, ...totals);
  // Time is read in hours, or minutes when no day reaches one.
  const unit = metric === "time" ? (most >= HOUR_MS ? HOUR_MS : 60_000) : 1;
  const max = niceMax(most / unit) * unit;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const step = days.length ? plotW / days.length : 0;
  const barW = Math.max(2, Math.min(24, step * 0.62));
  const y = (v: number) => PAD.top + plotH - (max ? (v / max) * plotH : 0);
  const fmt = (v: number) => {
    if (metric === "cost") return formatCost(v);
    if (metric === "time") return t(unit === HOUR_MS ? "usage.hours" : "usage.minutes", { count: Math.round((v / unit) * 10) / 10 });
    return metric === "turns" ? formatNumber(v) : formatTokens(v);
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.ceil(days.length / Math.max(1, Math.floor(plotW / 64)));
  const label = t(metric === "tokens" ? "usage.chartTokens" : metric === "cost" ? "usage.chartCost" : metric === "turns" ? "usage.chartTurns" : "usage.chartTime");

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="group" aria-label={label}>
          {ticks.map((tick, i) => (
            <g key={i} aria-hidden="true">
              <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--color-line)" />
              <text x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-subtle text-[11px] tabular-nums">
                {fmt(tick)}
              </text>
            </g>
          ))}
          {days.map((day, i) => {
            const cx = PAD.left + step * i + step / 2;
            let base = 0;
            const segs = series
              .map((s) => {
                const seg = { from: base, to: base + s.values[i]!, color: seriesColor(s.slot) };
                base = seg.to;
                return seg;
              })
              .filter((s) => s.to > s.from);
            return (
              <g key={day} opacity={hover === null || hover === i ? 1 : 0.45}>
                {segs.map((s, si) => {
                  const top = y(s.to);
                  // Every segment but the lowest leaves a gap so stacked fills read as separate.
                  const bottom = y(s.from) - (si > 0 ? GAP : 0);
                  const h = Math.max(0.5, bottom - top);
                  return <path key={si} d={bar(cx - barW / 2, top, barW, h, si === segs.length - 1 ? 4 : 0)} fill={s.color} />;
                })}
                {i % labelEvery === (days.length - 1) % labelEvery && (
                  // Kept inside the plot so the first and last labels are never clipped.
                  <text
                    x={Math.min(Math.max(cx, PAD.left + 18), width - PAD.right - 18)}
                    y={HEIGHT - 8}
                    textAnchor="middle"
                    className="fill-subtle text-[11px]"
                    aria-hidden="true"
                  >
                    {formatDay(day)}
                  </text>
                )}
                {/* The whole column is the target, not just the bar. A long range would be too many tab stops; its days are in the tables. */}
                <rect
                  x={PAD.left + step * i}
                  y={PAD.top}
                  width={step}
                  height={plotH}
                  fill="transparent"
                  role="img"
                  aria-label={`${formatDay(day, true)}: ${fmt(totals[i]!)}`}
                  tabIndex={days.length <= 31 ? 0 : undefined}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                />
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && days[hover] && (
        <Tooltip
          x={PAD.left + step * hover + step / 2}
          width={width}
          title={formatDay(days[hover], true)}
          rows={series.flatMap((s, i) => (s.values[hover] ? [{ color: seriesColor(s.slot), label: names[i]!, value: fmt(s.values[hover]) }] : []))}
          footer={`${t("usage.total")} ${fmt(totals[hover]!)}`}
        />
      )}
    </div>
  );
}

function Tooltip(props: {
  x: number;
  width: number;
  title: string;
  rows: { color?: string; label: string; value: string }[];
  footer: string;
}) {
  const w = Math.min(196, props.width);
  const left = Math.min(Math.max(0, props.x - w / 2), props.width - w);
  return (
    <div
      role="status"
      style={{ left, width: w }}
      className="pointer-events-none absolute top-0 rounded-lg border border-edge bg-bubble px-3 py-2 text-xs shadow-xl shadow-shadow"
    >
      <div className="mb-1.5 font-medium text-fg">{props.title}</div>
      {props.rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 py-0.5">
          <span className="size-2 flex-none rounded-sm" style={{ background: r.color ?? "transparent" }} />
          <span className="min-w-0 truncate text-muted">{r.label}</span>
          <span className="ml-auto flex-none tabular-nums text-fg">{r.value}</span>
        </div>
      ))}
      <div className="mt-1.5 border-t border-line pt-1.5 text-subtle">{props.footer}</div>
    </div>
  );
}

/** A bar with rounded top corners only, so it stays anchored to the baseline. */
function bar(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** Rounds the axis top up to 1, 2 or 5 times a power of ten, so gridlines land on round numbers. */
function niceMax(v: number) {
  if (v <= 0) return 0;
  const raw = v / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * pow >= raw)! * pow;
  return step * 4;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
