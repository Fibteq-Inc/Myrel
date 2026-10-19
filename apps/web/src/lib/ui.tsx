import type { ButtonHTMLAttributes, InputHTMLAttributes } from "react";

export function Button({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-sm font-medium text-ground hover:bg-[#a3b0ff] disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}

export function GhostButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-edge bg-raised px-2.5 text-[13px] text-fg hover:bg-hover disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}

export function IconButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg ${className}`}
      {...props}
    />
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-9 w-full rounded-lg border border-edge bg-raised px-3 text-sm text-fg outline-none placeholder:text-subtle focus:border-accent ${className}`}
      {...props}
    />
  );
}

/** The assistant's mark, used as its avatar. */
export function AltairMark({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="flex flex-none items-center justify-center rounded-[9px] border border-[#343a6b] bg-gradient-to-br from-[#2a2e52] to-[#15172a]"
    >
      <svg width={size / 2} height={size / 2} viewBox="0 0 24 24" fill="currentColor" className="text-accent">
        <path d="M12 1.5l2.2 7.3 7.3 2.2-7.3 2.2L12 22.5l-2.2-9.3L2.5 11l7.3-2.2z" />
      </svg>
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

export function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "Something went wrong";
}
