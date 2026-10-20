export type PlatformName = "web" | "desktop" | "mobile";

/** Small persistent key/value store (localStorage, Tauri store, AsyncStorage). */
export interface KeyValueStore {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string | null): void | Promise<void>;
}

export type PickedFile = { name: string; type: string; size: number; blob: Blob };

/** What the bundled myrel-runner is doing (its `start --json` states, plus `error` when it crashed). */
export type ComputerStatus =
  | { state: "connecting" }
  | { state: "online"; name: string }
  | { state: "offline"; reason: string; retryInMs: number }
  | { state: "stopped"; reason: string }
  | { state: "error"; message: string };

export type ComputerAccess = "read" | "edit" | "full";

export type ComputerInfo = {
  paired: boolean;
  /** The Myrel server this computer is paired with. */
  server?: string;
  runnerId?: string;
  access: ComputerAccess;
  clis: { id: string; version: string | null }[];
  status: ComputerStatus;
  hostname: string;
  platform: string;
};

/**
 * The computer the app runs on, as an Myrel runner (desktop only): pair it with one click and
 * keep the bundled myrel-runner running while the app is open. Folders are shared from the
 * Devices page like any other runner.
 */
export interface LocalComputer {
  info(): Promise<ComputerInfo>;
  /** Saves the runner login from `POST /api/runner/pair` (in the OS keychain) and starts the runner. */
  connect(login: { server: string; runnerId: string; token: string }): Promise<void>;
  setAccess(access: ComputerAccess): Promise<void>;
  start(): Promise<void>;
  /** Stops the runner and forgets the pairing on this computer. */
  disconnect(): Promise<void>;
  onStatus(listener: (status: ComputerStatus) => void): () => void;
}

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
  /** Desktop only: this computer as a runner for local folders. */
  computer?: LocalComputer;
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
