export type PlatformName = "web" | "desktop" | "mobile";

/** Small persistent key/value store (localStorage, Tauri store, AsyncStorage). */
export interface KeyValueStore {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string | null): void | Promise<void>;
}

export type PickedFile = { name: string; type: string; size: number; blob: Blob };

/**
 * Everything the UI needs from its host. apps/web uses `webPlatform()`; the
 * desktop shell (Tauri) and mobile app (Expo) provide their own, backed by the
 * OS keychain, native notifications and native file dialogs.
 */
export interface Platform {
  name: PlatformName;
  storage: KeyValueStore;
  /** Storage for credentials (OS keychain); falls back to `storage` when absent. */
  secrets?: KeyValueStore;
  notify(input: { title: string; body?: string }): void | Promise<void>;
  openExternal(url: string): void | Promise<void>;
  pickFiles(options?: { multiple?: boolean; accept?: string[] }): Promise<PickedFile[]>;
}

/** Key/value store over Web Storage; falls back to memory when storage is blocked. */
export function webStorage(prefix = "myrel:"): KeyValueStore {
  const memory = new Map<string, string>();
  const ls = (() => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  })();
  return {
    get(key) {
      try {
        if (ls) return ls.getItem(prefix + key);
      } catch {}
      return memory.get(key) ?? null;
    },
    set(key, value) {
      try {
        if (ls) {
          if (value === null) ls.removeItem(prefix + key);
          else ls.setItem(prefix + key, value);
          return;
        }
      } catch {}
      if (value === null) memory.delete(key);
      else memory.set(key, value);
    },
  };
}

/** Browser platform. Bearer tokens for a cross-origin server live in localStorage (see `tokenStoreFor`). */
export function webPlatform(): Platform {
  return {
    name: "web",
    storage: webStorage(),
    async notify({ title, body }) {
      if (typeof Notification === "undefined") return;
      if (Notification.permission === "default") await Notification.requestPermission();
      if (Notification.permission === "granted") new Notification(title, { body });
    },
    openExternal(url) {
      globalThis.open?.(url, "_blank", "noopener,noreferrer");
    },
    pickFiles({ multiple = false, accept = [] } = {}) {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = multiple;
        input.accept = accept.join(",");
        input.onchange = () =>
          resolve(Array.from(input.files ?? [], (f) => ({ name: f.name, type: f.type, size: f.size, blob: f })));
        input.oncancel = () => resolve([]);
        input.click();
      });
    },
  };
}
