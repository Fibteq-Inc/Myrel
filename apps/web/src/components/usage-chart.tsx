import { useT } from "@myrel/i18n/react";
import type { UsageDay } from "@myrel/protocol";
import { useLayoutEffect, useRef, useState } from "react";
import { useFormat } from "../lib/format";

export type ChartMetric = "tokens" | "cost";

/** Series colours, stepped for the dark surface (input below, output stacked on top). */
export const SERIES = { input: "#3987e5", output: "#d95926" } as const;

const HEIGHT = 220;
const PAD = { top: 12, right: 8, bottom: 26, left: 48 };
const GAP = 2;

/** Daily bars: input + output tokens stacked, or estimated cost. Hover a day for its numbers. */
export function UsageChart({ days, metric }: { days: UsageDay[]; metric: ChartMetric }) {
  const t = useT();
  const { tokens: formatTokens, cost: formatCost, day: formatDay } = useFormat();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const values = days.map((d) =>
    metric === "tokens" ? [d.inputTokens, d.outputTokens] : [d.costMicros],
  );
  const max = niceMax(Math.max(0, ...values.map((v) => v.reduce((a, b) => a + b, 0))));
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const step = days.length ? plotW / days.length : 0;
  const barW = Math.max(2, Math.min(28, step * 0.62));
  const y = (v: number) => PAD.top + plotH - (max ? (v / max) * plotH : 0);
  const fmt = (v: number) => (metric === "tokens" ? formatTokens(v) : formatCost(v));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.ceil(days.length / Math.max(1, Math.floor(plotW / 64)));
  const colors = metric === "tokens" ? [SERIES.input, SERIES.output] : [SERIES.input];

  const hovered = hover === null ? null : days[hover];

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={metric === "tokens" ? t("usage.chartTokens") : t("usage.chartCost")}>
          {ticks.map((tick, i) => (
            <g key={i}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--color-line)" />
              <text x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-subtle text-[11px] tabular-nums">
                {fmt(tick)}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const cx = PAD.left + step * i + step / 2;
            let base = 0;
            const segs = values[i]!.map((v, s) => {
              const seg = { from: base, to: base + v, color: colors[s]! };
              base += v;
              return seg;
            }).filter((s) => s.to > s.from);
            return (
              <g key={d.date} opacity={hover === null || hover === i ? 1 : 0.45}>
                {segs.map((s, si) => {
                  const top = y(s.to);
                  // Every segment but the lowest leaves a gap so stacked fills read as separate.
                  const bottom = y(s.from) - (si > 0 ? GAP : 0);
                  const h = Math.max(0, bottom - top);
                  return h > 0 ? (
                    <path key={si} d={bar(cx - barW / 2, top, barW, h, si === segs.length - 1 ? 3 : 0)} fill={s.color} />
                  ) : null;
                })}
                {i % labelEvery === (days.length - 1) % labelEvery && (
                  // Kept inside the plot so the first and last labels are never clipped.
                  <text
                    x={Math.min(Math.max(cx, PAD.left + 18), width - PAD.right - 18)}
                    y={HEIGHT - 8}
                    textAnchor="middle"
                    className="fill-subtle text-[11px]"
                  >
                    {formatDay(d.date)}
                  </text>
                )}
                {/* The whole column is the hover target, not just the bar. */}
                <rect
                  x={PAD.left + step * i}
                  y={PAD.top}
                  width={step}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                />
              </g>
            );
          })}
        </svg>
      )}
      {hovered && hover !== null && (
        <Tooltip
          x={PAD.left + step * hover + step / 2}
          width={width}
          title={formatDay(hovered.date, true)}
          rows={
            metric === "tokens"
              ? [
                  { color: SERIES.input, label: t("usage.input"), value: formatTokens(hovered.inputTokens) },
                  { color: SERIES.output, label: t("usage.output"), value: formatTokens(hovered.outputTokens) },
                  { label: t("usage.costShort"), value: formatCost(hovered.costMicros) },
                ]
              : [
                  { color: SERIES.input, label: t("usage.costShort"), value: formatCost(hovered.costMicros) },
                  { label: t("usage.tokens"), value: formatTokens(hovered.inputTokens + hovered.outputTokens) },
                ]
          }
          footer={t("usage.modelCalls", { count: hovered.calls })}
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
  const w = 168;
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
          <span className="text-muted">{r.label}</span>
          <span className="ml-auto tabular-nums text-fg">{r.value}</span>
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
