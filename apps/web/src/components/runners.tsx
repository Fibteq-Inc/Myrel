import type { Translate } from "@altair/i18n";
import { useT } from "@altair/i18n/react";
import { CLI_NAMES, type Runner, type RunnerPairingCode } from "@altair/protocol";
import { Check, Copy, Laptop, Monitor } from "lucide-react";
import { useEffect, useState } from "react";

/** Green when connected, grey when not. */
export function OnlineDot({ online, className = "" }: { online: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2 flex-none rounded-full ${online ? "bg-ok shadow-[0_0_0_3px_rgba(79,203,141,0.15)]" : "bg-[#55555e]"} ${className}`}
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
        <span key={c.id} className="rounded-md border border-edge bg-panel px-1.5 py-0.5 text-[11px] text-muted">
          {CLI_NAMES[c.id]}
        </span>
      ))}
    </span>
  );
}

/** A shell command with a copy button. */
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
