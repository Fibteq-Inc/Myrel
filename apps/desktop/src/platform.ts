import { type KeyValueStore, keychainStore, type PickedFile, type Platform } from "@myrel/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LazyStore } from "@tauri-apps/plugin-store";
import { desktopComputer } from "./computer";
import { desktopUpdater } from "./updater";

/** Settings (chosen server and the like) in the app's data folder. */
function settingsStore(): KeyValueStore {
  const store = new LazyStore("settings.json");
  return {
    async get(key) {
      return (await store.get<string>(key)) ?? null;
    },
    async set(key, value) {
      if (value === null) await store.delete(key);
      else await store.set(key, value);
    },
  };
}

/**
 * Credentials in the OS keychain (macOS Keychain, Windows Credential Manager,
 * Secret Service on Linux). When it fails (or a Linux desktop has no Secret
 * Service), the settings store keeps them so sign-in still works; see keychainStore.
 */
function keychain(fallback: KeyValueStore): KeyValueStore {
  return keychainStore(
    {
      get: (key) => invoke<string | null>("secret_get", { key }),
      set: async (key, value) => {
        await invoke("secret_set", { key, value });
      },
    },
    fallback,
    (err) => {
      console.warn("Keychain unavailable, using app storage", err);
      // Reported like an uncaught error, so it shows under Settings › Server › Errors. The OS's message
      // names what failed, never the stored value.
      const error = new Error(`Keychain: ${err instanceof Error ? err.message : String(err)}`);
      error.name = "KeychainError";
      globalThis.reportError?.(error);
    },
  );
}

const MIME: Record<string, string> = {
  csv: "text/csv",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  zip: "application/zip",
};

function mimeFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

/** Turns `accept` entries (".pdf", "image/png", "image/*") into a dialog filter. */
function filtersFor(accept: string[]) {
  const extensions = accept.flatMap((a) => {
    if (a.startsWith(".")) return [a.slice(1)];
    if (a.endsWith("/*")) {
      const prefix = a.slice(0, -1);
      return Object.entries(MIME).flatMap(([ext, type]) => (type.startsWith(prefix) ? [ext] : []));
    }
    return Object.entries(MIME).flatMap(([ext, type]) => (type === a ? [ext] : []));
  });
  return extensions.length ? [{ name: "Files", extensions }] : undefined;
}

async function pickFiles({ multiple = false, accept = [] }: { multiple?: boolean; accept?: string[] } = {}) {
  const picked = await open({ multiple, directory: false, filters: filtersFor(accept) });
  const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
  return Promise.all(
    paths.map(async (path): Promise<PickedFile> => {
      const name = path.split(/[\\/]/).pop() ?? path;
      const type = mimeFor(name);
      const blob = new Blob([await readFile(path)], { type });
      return { name, type, size: blob.size, blob };
    }),
  );
}

export function desktopPlatform(): Platform {
  const storage = settingsStore();
  return {
    name: "desktop",
    storage,
    secrets: keychain(storage),
    async notify({ title, body }) {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) sendNotification({ title, body });
    },
    openExternal: (url) => openUrl(url),
    pickFiles,
    computer: desktopComputer(),
    updater: desktopUpdater(),
    setWindowTheme: (theme) => getCurrentWindow().setTheme(theme),
  };
}
