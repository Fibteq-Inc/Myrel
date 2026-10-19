import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

/** Joins class names, skipping falsy ones. */
export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

export function Button({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-sm font-medium text-ground hover:bg-[#a3b0ff] disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function GhostButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-edge bg-raised px-2.5 text-[13px] text-fg hover:bg-hover disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function IconButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex size-9 flex-none items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-lg border border-edge bg-raised px-3 text-sm text-fg outline-none placeholder:text-subtle focus:border-accent",
        className,
      )}
      {...props}
    />
  );
}

/** A keyboard shortcut hint, e.g. ⌘K. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-[#2e2e34] px-1.5 font-mono text-[11px] leading-4 text-subtle">{children}</kbd>
  );
}

/** The assistant's mark, used as its avatar. */
export function AltairMark({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
      className="flex flex-none items-center justify-center border border-[#343a6b] bg-gradient-to-br from-[#2a2e52] to-[#15172a]"
    >
      <svg width={size / 2} height={size / 2} viewBox="0 0 24 24" fill="currentColor" className="text-accent">
        <path d="M12 1.5l2.2 7.3 7.3 2.2-7.3 2.2L12 22.5l-2.2-9.3L2.5 11l7.3-2.2z" />
      </svg>
    </span>
  );
}

const AVATAR_GRADIENTS = [
  "from-[#5b6cff] to-[#9b5bff]",
  "from-[#ff8a5b] to-[#e0457b]",
  "from-[#35c49a] to-[#2178c4]",
  "from-[#f5b94a] to-[#e0663d]",
  "from-[#4fb3ff] to-[#5b6cff]",
];

/** A person's initials on a gradient that stays the same for the same id. */
export function UserAvatar({
  id,
  name,
  size = 32,
  className = "",
}: {
  id: string;
  name: string;
  size?: number;
  className?: string;
}) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const gradient = AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) }}
      className={cn(
        "flex flex-none items-center justify-center rounded-full bg-gradient-to-br font-semibold text-white",
        gradient,
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

export function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toLocaleUpperCase())
      .join("") || "?"
  );
}

/** "now", "5m", "3h", "2d", then a short date. */
export function relativeTime(iso: string, now = Date.now()) {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "Something went wrong";
}
