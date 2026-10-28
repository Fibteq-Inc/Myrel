import type { KeyValueStore } from "./platform";

/** One storage key holds every draft, so signing out clears them all at once. */
const KEY = "drafts";
/** A draft untouched this long is dropped, and only the newest ones are kept. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DRAFTS = 100;

type Saved = Record<string, { text: string; at: number }>;

/** Where a composer's draft is kept: the project chat, or one thread of the project. */
export function draftKey(projectId: string, threadId?: string | null): string {
  return threadId ? `${projectId}/${threadId}` : projectId;
}

/**
 * Unsent composer text, kept on this device per project chat and per thread so it survives
 * switching projects, tabs or restarting the app. Never sent anywhere. `get` answers at once
 * when the store is synchronous (localStorage); otherwise after `ready`.
 */
export function createDraftStore(store: KeyValueStore, now: () => number = Date.now) {
  let drafts: Saved | null = null;

  function parse(raw: string | null): Saved {
    try {
      const value = JSON.parse(raw ?? "{}") as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Saved) : {};
    } catch {
      return {};
    }
  }

  function fresh(saved: Saved): Saved {
    const cutoff = now() - MAX_AGE_MS;
    const kept = Object.entries(saved)
      .filter(([, d]) => typeof d?.text === "string" && d.text && typeof d.at === "number" && d.at >= cutoff)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, MAX_DRAFTS);
    return Object.fromEntries(kept);
  }

  const loaded = (() => {
    const raw = store.get(KEY);
    if (raw instanceof Promise) {
      return raw.then(
        (r) => {
          drafts ??= fresh(parse(r));
        },
        () => {
          drafts ??= {};
        },
      );
    }
    drafts = fresh(parse(raw));
    return Promise.resolve();
  })();

  function persist() {
    const value = drafts && Object.keys(drafts).length ? JSON.stringify(drafts) : null;
    Promise.resolve(store.set(KEY, value)).catch(() => {});
  }

  return {
    /** Resolves once the saved drafts are read. */
    ready: loaded,
    /** The saved text for `key`, "" when there is none or the drafts are not read yet. */
    get(key: string): string {
      return drafts?.[key]?.text ?? "";
    },
    /** Saves `text` for `key`; empty text drops the draft. */
    set(key: string, text: string) {
      if (!drafts) {
        void loaded.then(() => this.set(key, text));
        return;
      }
      if (text.trim()) drafts = fresh({ ...drafts, [key]: { text, at: now() } });
      else if (key in drafts) {
        const { [key]: _, ...rest } = drafts;
        drafts = rest;
      } else return;
      persist();
    },
    /** Forgets every draft, e.g. when the account signs out. */
    clear() {
      drafts = {};
      persist();
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;
