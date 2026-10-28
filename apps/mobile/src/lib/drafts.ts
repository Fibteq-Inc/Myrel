import { createDraftStore } from "@myrel/client";
import { useEffect, useState } from "react";
import { platform } from "./platform";

/** Unsent composer text on this device (AsyncStorage), read once when the app starts. */
export const drafts = createDraftStore(platform.storage);

type Draft = { key: string; text: string; typed: boolean };

/**
 * A composer's text, saved under `key` as it changes and given back when the composer opens
 * again, also after leaving the project or restarting the app.
 */
export function useDraft(key: string) {
  const [draft, setDraft] = useState<Draft>(() => ({ key, text: drafts.get(key), typed: false }));
  // Another project or thread in the same composer: its own draft comes back.
  if (draft.key !== key) setDraft({ key, text: drafts.get(key), typed: false });
  // Drafts are read asynchronously: one that arrives after the composer opened fills it, unless the person already typed.
  useEffect(() => {
    let live = true;
    void drafts.ready.then(() => {
      if (live) setDraft((d) => (d.key === key && !d.typed ? { ...d, text: drafts.get(key) } : d));
    });
    return () => {
      live = false;
    };
  }, [key]);
  useEffect(() => {
    // Only what the person typed is saved: the empty text of a composer opened before the drafts were read must not drop its draft.
    if (draft.typed) drafts.set(draft.key, draft.text);
  }, [draft]);
  const text = draft.key === key ? draft.text : "";
  const setText = (next: string | ((prev: string) => string)) =>
    setDraft((d) => ({ key: d.key, text: typeof next === "function" ? next(d.text) : next, typed: true }));
  return [text, setText] as const;
}
