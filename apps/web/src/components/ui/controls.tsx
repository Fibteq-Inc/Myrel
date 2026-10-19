import type { InputHTMLAttributes, SelectHTMLAttributes } from "react";
import { cn } from "../../lib/ui";

/**
 * A select in the app's look. It stays a native <select> so keyboard,
 * screen readers and forms keep working; styles.css (`.ui-select`) draws it.
 */
export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "ui-select h-9 rounded-lg border border-edge bg-raised px-2.5 text-sm text-fg outline-none focus:border-accent",
        // Full width unless the caller sets one (cn does not merge conflicting classes).
        !/(^|\s)(sm:)?w-/.test(className) && "w-full",
        className,
      )}
      {...props}
    />
  );
}

type BoxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

/** A checkbox in the app's look (`.ui-check`). */
export function Checkbox({ className = "", ...props }: BoxProps) {
  return <input type="checkbox" className={cn("ui-check", className)} {...props} />;
}

/** An on/off switch (`.ui-switch`): a checkbox announced as a switch. */
export function Switch({ className = "", ...props }: BoxProps) {
  return <input type="checkbox" role="switch" className={cn("ui-switch", className)} {...props} />;
}
