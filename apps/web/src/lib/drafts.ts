import { createDraftStore, webStorage } from "@myrel/client";
import { useEffect, useState } from "react";

/**
 * Unsent composer text on this device. localStorage on purpose (also in the desktop app's
 * webview): it is synchronous, so a composer opens with its draft already in place.
 */
export const drafts = createDraftStore(webStorage());

/**
 * A composer's text, saved under `key` as it changes and given back when the composer opens
 * again, also after switching projects or tabs or restarting the app. Without a key it is
 * plain state.
 */
export function useDraft(key: string | undefined) {
  const [draft, setDraft] = useState(() => ({ key, text: key ? drafts.get(key) : "" }));
  // Another project or thread in the same composer: its own draft comes back.
  if (draft.key !== key) setDraft({ key, text: key ? drafts.get(key) : "" });
  const text = draft.key === key ? draft.text : "";
  useEffect(() => {
    if (draft.key) drafts.set(draft.key, draft.text);
  }, [draft]);
  const setText = (next: string | ((prev: string) => string)) =>
    setDraft((d) => ({ key: d.key, text: typeof next === "function" ? next(d.text) : next }));
  return [text, setText] as const;
}
