import { useT } from "@myrel/i18n/react";
import type { Thread } from "@myrel/protocol";
import { Check, ChevronDown, Search } from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useState } from "react";
import { useFormat } from "../lib/format";
import { cn } from "../lib/ui";

/**
 * Picks where a routine runs: the project chat ("") or one of the project's threads. The list opens
 * in place (no floating panel, so it behaves the same in a narrow phone view), with a search box and
 * the most recently active threads first.
 */
export function ThreadPicker({
  threads,
  value,
  onChange,
  label,
}: {
  threads: Thread[];
  /** A thread id, or "" for the project chat. */
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const t = useT();
  const format = useFormat();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();

  const chat = { id: "", title: t("routines.targetChat") };
  const options = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const matches = threads
      .filter((th) => !q || th.title.toLocaleLowerCase().includes(q))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return q ? matches : [null, ...matches];
  }, [threads, query]);

  const selected = threads.find((th) => th.id === value);
  const current = !value
    ? chat.title
    : t("routines.targetThread", { title: selected?.title ?? t("routines.aThread") });

  function pick(id: string) {
    onChange(id);
    setOpen(false);
    setQuery("");
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.min(Math.max(i + step, 0), options.length - 1));
    } else if (e.key === "Enter") {
      // Enter picks the highlighted option instead of submitting the routine form.
      e.preventDefault();
      const option = options[active];
      if (option !== undefined) pick(option?.id ?? "");
    }
  }

  return (
    <div>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          setOpen((o) => !o);
          setActive(0);
        }}
        className="flex h-9 w-full items-center gap-2 rounded-lg border border-edge bg-raised px-2.5 text-left text-sm text-fg outline-none focus:border-accent"
      >
        <span className="min-w-0 flex-1 truncate">{current}</span>
        <ChevronDown size={14} className={cn("flex-none text-muted transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        <div className="mt-1.5 overflow-hidden rounded-lg border border-edge bg-raised">
          <label className="flex items-center gap-2 border-b border-line px-2.5">
            <Search size={14} className="flex-none text-subtle" aria-hidden="true" />
            <input
              autoFocus
              type="search"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={options.length ? `${listId}-${active}` : undefined}
              aria-label={t("routines.searchThreads")}
              placeholder={t("routines.searchThreads")}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKey}
              className="h-9 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
            />
          </label>
          <ul id={listId} role="listbox" aria-label={label} className="max-h-60 overflow-y-auto py-1">
            {options.map((th, i) => {
              const id = th?.id ?? "";
              return (
                <li
                  key={id || "chat"}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={id === value}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(id)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 px-2.5 py-2 text-sm",
                    i === active ? "bg-ground text-fg" : "text-muted",
                  )}
                >
                  <Check size={14} className={cn("flex-none", id === value ? "text-accent" : "invisible")} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{th ? th.title : chat.title}</span>
                  {th && <span className="flex-none text-[11px] text-subtle">{format.relative(th.updatedAt)}</span>}
                </li>
              );
            })}
            {!options.length && <li className="px-2.5 py-2 text-sm text-subtle">{t("routines.noThreadMatch")}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
