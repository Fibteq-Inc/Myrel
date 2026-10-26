import { useT } from "@myrel/i18n/react";

/** Rows of the placeholder: an agent's reply (its line widths) or a person's bubble. */
const ROWS: ({ agent: string[] } | { bubble: string })[] = [
  { agent: ["w-11/12", "w-4/5", "w-2/5"] },
  { bubble: "w-2/5" },
  { agent: ["w-full", "w-3/4"] },
  { bubble: "w-1/3" },
  { agent: ["w-5/6", "w-1/2"] },
];

/** Enough rows to fill a tall window; the area they sit in clips the oldest at its top. */
const FILL = Array.from({ length: 18 }, (_, i) => ROWS[i % ROWS.length]!);

/**
 * The shape of a conversation while its messages load, in place of a spinner. Put it at the bottom
 * of an area that hides what overflows (`justify-end overflow-hidden`), so it fills the area from the newest end.
 */
export function ChatSkeleton() {
  const t = useT();
  return (
    <div role="status" aria-label={t("chat.loading")} className="flex flex-none animate-pulse flex-col gap-7">
      {FILL.map((row, i) =>
        "bubble" in row ? (
          <div key={i} className="flex justify-end">
            <div className={`h-10 ${row.bubble} rounded-2xl rounded-br-md bg-bubble`} />
          </div>
        ) : (
          <div key={i} className="flex gap-3.5">
            <div className="size-7 flex-none rounded-full bg-bubble" />
            <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-1.5">
              {row.agent.map((width, j) => (
                <div key={j} className={`h-3 ${width} rounded bg-bubble`} />
              ))}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
