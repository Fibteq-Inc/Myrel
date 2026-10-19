import type { ReactNode, SelectHTMLAttributes } from "react";

/** A titled block on a settings page. */
export function Section({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-subtle">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-[13px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-subtle">{hint}</span>}
    </label>
  );
}

export { Select } from "./ui/controls";

/** Bordered list used for keys, members and invites. */
export function List({ children, empty }: { children: ReactNode[]; empty: string }) {
  if (children.length === 0) return <p className="text-[13px] text-subtle">{empty}</p>;
  return <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-raised">{children}</ul>;
}

export function Row({ children }: { children: ReactNode }) {
  return <li className="flex items-center gap-3 px-4 py-3">{children}</li>;
}

export function Badge({ children }: { children: ReactNode }) {
  return <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">{children}</span>;
}

export function Notice({ tone = "bad", children }: { tone?: "bad" | "ok"; children: ReactNode }) {
  return <p className={`text-[13px] ${tone === "ok" ? "text-ok" : "text-bad"}`}>{children}</p>;
}
