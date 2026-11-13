import type { Translate } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import { CLI_NAMES, type CliLimitWindow, cliLogins, type Runner, type RunnerCli, type RunnerPairingCode, type RunnerStats, VISUAL_CHECK_DEPS_COMMAND } from "@myrel/protocol";
import { Check, Copy, Laptop, Monitor } from "lucide-react";
import { useEffect, useState } from "react";
import { useFormat } from "../lib/format";

/** Green when connected, grey when not. */
export function OnlineDot({ online, className = "" }: { online: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2 flex-none rounded-full ${online ? "bg-ok shadow-[0_0_0_3px_rgba(79,203,141,0.15)]" : "bg-offline"} ${className}`}
    />
  );
}

export function RunnerIcon({ runner, size = 18 }: { runner: Pick<Runner, "platform">; size?: number }) {
  // Laptops and desktops look alike to us; macOS gets the laptop, everything else the monitor.
  const Icon = runner.platform === "darwin" ? Laptop : Monitor;
  return <Icon size={size} aria-hidden="true" />;
}

export function lastSeen(runner: Runner, t: Translate): string {
  if (runner.online) return t("runners.online");
  if (!runner.lastSeenAt) return t("runners.neverConnected");
  const minutes = Math.round((Date.now() - new Date(runner.lastSeenAt).getTime()) / 60_000);
  if (minutes < 1) return t("runners.seenJustNow");
  if (minutes < 60) return t("runners.seenMinutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("runners.seenHoursAgo", { count: hours });
  return t("runners.offlineSince", { date: new Date(runner.lastSeenAt).toLocaleDateString() });
}

export function CliChips({ runner }: { runner: Runner }) {
  const t = useT();
  if (runner.clis.length === 0) {
    return (
      <span className="text-xs text-subtle">{runner.version ? t("runners.noCli") : t("runners.notConnectedYet")}</span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {runner.clis.map((c) => (
        <span key={c.id} className="rounded-md border border-edge bg-panel px-1.5 py-0.5 text-[11px] text-muted" title={c.version ?? undefined}>
          {CLI_NAMES[c.id]}
          {cliVersion(c) && <span className="ml-1 text-subtle">{cliVersion(c)}</span>}
          {!!c.accounts?.length && <span className="ml-1 text-subtle">· {t("runners.accounts", { count: c.accounts.length + 1 })}</span>}
        </span>
      ))}
    </span>
  );
}

/** "2.1.308 (Claude Code)" or "codex-cli 0.163.0" → "2.1.308", "0.163.0". */
export function cliVersion(cli: RunnerCli): string | null {
  return cli.version?.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)?.[0] ?? cli.version;
}

/** Windows the web app knows how to name; others are skipped. */
const LIMIT_KINDS = ["session", "weekly", "weekly_opus", "weekly_sonnet"] as const;
type LimitKind = (typeof LIMIT_KINDS)[number];
const isKnown = (w: CliLimitWindow): w is CliLimitWindow & { kind: LimitKind } =>
  (LIMIT_KINDS as readonly string[]).includes(w.kind);

/** CLIs that report subscription limits (Antigravity CLI does not). */
const LIMITED_CLIS = new Set<RunnerCli["id"]>(["claude", "codex"]);

/**
 * The subscription limits of the computer's CLIs, as each CLI last reported them: Claude Code
 * during runs from Myrel, Codex whenever it is used. A CLI with several logins on the computer
 * (`myrel-runner claude add`) shows each login's own.
 */
export function CliLimitsList({ runner }: { runner: Runner }) {
  const t = useT();
  const format = useFormat();
  const rows = runner.clis
    .filter((c) => LIMITED_CLIS.has(c.id))
    .flatMap((c) => {
      const logins = cliLogins(c);
      return logins.map((l) => ({
        key: `${c.id}@${l.account ?? ""}`,
        name: logins.length > 1 ? `${CLI_NAMES[c.id]} · ${l.name ?? t("cliPicker.ownLogin")}` : CLI_NAMES[c.id],
        limits: l.limits,
      }));
    });
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2.5 border-t border-line pt-3">
      <h3 className="text-xs text-subtle">{t("runners.limitsTitle")}</h3>
      {rows.map((c) => {
        const windows = (c.limits?.windows ?? []).filter(isKnown);
        return (
          <div key={c.key} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-[13px]">
              <span className="min-w-0 truncate font-medium">{c.name}</span>
              {c.limits?.status === "limited" && <span className="flex-none text-xs text-bad">{t("runners.limitReached")}</span>}
              {c.limits?.status === "warning" && <span className="flex-none text-xs text-warn">{t("runners.limitWarning")}</span>}
              {c.limits && (
                <span className="ml-auto flex-none text-[11px] text-subtle" title={format.dateTime(c.limits.at)}>
                  {t("runners.limitsUpdated", { time: format.relative(c.limits.at) })}
                </span>
              )}
            </div>
            {windows.length === 0 ? (
              <p className="text-xs text-subtle">{t("runners.limitsPending")}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {windows.map((w) => (
                  <LimitBar key={w.kind} window={w} label={t(`runners.limit.${w.kind}`)} />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Memory this full is shown red, and a note says why it matters. */
export const MEMORY_LOW_PERCENT = 90;

/**
 * "CPU 41% · RAM 11.2/12 GB": the computer's latest sample in one line, for lists. `compact` drops
 * the words and rounds, "41% · 11/12 GB", for a pill next to a long computer name.
 */
export function usageSummary(stats: RunnerStats, t: Translate, format: ReturnType<typeof useFormat>, compact = false): string {
  return t(compact ? "runners.usage.summaryShort" : "runners.usage.summary", {
    cpu: stats.cpu.percent === undefined ? "–" : t("runners.usage.percent", { percent: Math.round(stats.cpu.percent) }),
    memory: format.bytesOf(stats.memory.total - stats.memory.available, stats.memory.total, compact),
  });
}

/** Whether the latest sample says memory is nearly full (shown in the warning colour). */
export function memoryLow(stats: RunnerStats): boolean {
  return stats.memory.total > 0 && (stats.memory.total - stats.memory.available) / stats.memory.total >= MEMORY_LOW_PERCENT / 100;
}

/**
 * How busy the computer is, as its runner measured it with its last ping (feature "stats", runner
 * 0.29.0): only while it is online, since a figure from before it went away would mislead.
 */
export function RunnerUsage({ runner }: { runner: Runner }) {
  const t = useT();
  const format = useFormat();
  const stats = runner.online ? runner.stats : undefined;
  if (!stats) return null;
  const memoryUsed = stats.memory.total - stats.memory.available;
  const memoryPercent = percentOf(memoryUsed, stats.memory.total);
  const noSwap = stats.swap?.total === 0;
  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-3">
      <div className="flex items-center gap-2 text-xs">
        <h3 className="text-subtle">{t("runners.usageTitle")}</h3>
        <span className="text-muted">{stats.tasks > 0 ? t("runners.usage.tasks", { count: stats.tasks }) : t("runners.usage.idle")}</span>
        <span className="ml-auto text-[11px] text-subtle" title={format.dateTime(stats.at)}>
          {t("runners.usage.updated", { time: format.relative(stats.at) })}
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        <UsageBar
          label={t("runners.usage.cpu", { count: stats.cpu.cores })}
          value={stats.cpu.percent === undefined ? "–" : t("runners.usage.percent", { percent: Math.round(stats.cpu.percent) })}
          percent={stats.cpu.percent ?? null}
        />
        <UsageBar
          label={t("runners.usage.memory")}
          value={t("runners.usage.ofTotal", { used: format.bytes(memoryUsed), total: format.bytes(stats.memory.total) })}
          percent={memoryPercent}
          note={memoryPercent !== null && memoryPercent >= MEMORY_LOW_PERCENT ? t("runners.usage.memoryLow") : noSwap && memoryPercent !== null && memoryPercent >= 70 ? t("runners.usage.noSwap") : undefined}
        />
        {stats.swap && stats.swap.total > 0 && (
          <UsageBar
            label={t("runners.usage.swap")}
            value={t("runners.usage.ofTotal", { used: format.bytes(stats.swap.used), total: format.bytes(stats.swap.total) })}
            percent={percentOf(stats.swap.used, stats.swap.total)}
          />
        )}
        {stats.disk && (
          <UsageBar
            label={t("runners.usage.disk")}
            value={t("runners.usage.free", { amount: format.bytes(stats.disk.free) })}
            percent={percentOf(stats.disk.total - stats.disk.free, stats.disk.total)}
            // A disk is usually quite full; only a nearly full one is worth a colour.
            warnAt={90}
            badAt={97}
          />
        )}
      </ul>
    </div>
  );
}

function percentOf(part: number, whole: number): number | null {
  return whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : null;
}

function UsageBar({ label, value, percent, note, warnAt = 70, badAt = 90 }: { label: string; value: string; percent: number | null; note?: string; warnAt?: number; badAt?: number }) {
  const tone = percent === null ? "bg-edge" : percent >= badAt ? "bg-bad" : percent >= warnAt ? "bg-warn" : "bg-ok";
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-xs">
      <span className="truncate text-muted">{label}</span>
      <span className="text-right tabular-nums text-muted">{value}</span>
      <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-panel" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${percent ?? 0}%` }} />
      </span>
      {note && <span className={`col-span-2 text-[11px] ${percent !== null && percent >= badAt ? "text-bad" : "text-subtle"}`}>{note}</span>}
    </li>
  );
}

function LimitBar({ window: w, label }: { window: CliLimitWindow; label: string }) {
  const t = useT();
  const format = useFormat();
  // A window that has reset since the CLI reported it starts again from zero.
  const reset = w.resetsAt !== null && Date.parse(w.resetsAt) <= Date.now();
  const used = reset ? 0 : w.usedPercent;
  const tone = used === null ? "bg-edge" : used >= 90 ? "bg-bad" : used >= 70 ? "bg-warn" : "bg-ok";
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-xs">
      <span className="truncate text-muted">{label}</span>
      <span className="text-right tabular-nums text-muted">
        {used === null ? "–" : t("runners.limitUsed", { percent: Math.round(used) })}
      </span>
      <span
        className="col-span-2 h-1.5 overflow-hidden rounded-full bg-panel"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used ?? undefined}
      >
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, used ?? 0)}%` }} />
      </span>
      {w.resetsAt && !reset && (
        <span className="col-span-2 text-[11px] text-subtle" title={format.dateTime(w.resetsAt)}>
          {t("runners.limitResets", { time: format.relative(w.resetsAt) })}
        </span>
      )}
    </li>
  );
}

/** A shell command with a copy button. */
/**
 * A computer whose runner said a visual check's browser cannot start there (Linux without
 * Chromium's system libraries): the one command its owner runs, with sudo, once.
 */
export function BrowserNotice({ runner }: { runner: Runner }) {
  const t = useT();
  if (runner.browser?.status !== "missing-libs") return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warn-line bg-warn-soft px-3 py-2.5 text-[13px] text-body">
      <p>{t("devices.browserMissing")}</p>
      <Command>{VISUAL_CHECK_DEPS_COMMAND}</Command>
    </div>
  );
}

export function Command({ children }: { children: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-edge bg-rail py-1.5 pl-3 pr-1.5 font-mono text-[12.5px]">
      <span className="select-none text-subtle">$</span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-fg">{children}</code>
      <button
        type="button"
        aria-label={t("runners.copyCommand")}
        title={t("common.copy")}
        onClick={async () => {
          await navigator.clipboard?.writeText(children);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="flex size-7 flex-none items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
      >
        {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/** The steps to connect a computer, with the pairing code filled in. */
export function PairingSteps({ pairing, server }: { pairing: RunnerPairingCode; server: string }) {
  const t = useT();
  const left = useCountdown(pairing.expiresAt);
  return (
    <ol className="flex flex-col gap-4">
      <Step n={1} title={t("runners.step1")}>
        <Command>{`npx myrel-runner pair ${pairing.code} --server ${server}`}</Command>
        <p className="text-xs text-subtle">
          {left > 0 ? t("runners.codeExpiresIn", { time: formatSeconds(left) }) : t("runners.codeExpired")}
        </p>
      </Step>
      <Step n={2} title={t("runners.step2")}>
        <Command>npx myrel-runner service install</Command>
        <p className="text-xs text-subtle">
          {t("runners.step2Body")}
        </p>
      </Step>
      <Step n={3} title={t("runners.step3")}>
        <p className="text-[13px] text-muted">
          {t("runners.step3Body")}
        </p>
      </Step>
    </ol>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 flex-none items-center justify-center rounded-full border border-edge bg-panel text-xs font-semibold text-muted">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="pt-0.5 font-medium">{title}</span>
        {children}
      </div>
    </li>
  );
}

function useCountdown(until: string) {
  const [left, setLeft] = useState(() => Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [until]);
  return left;
}

function formatSeconds(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
