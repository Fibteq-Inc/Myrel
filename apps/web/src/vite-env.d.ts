/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API origin when the UI is not served by the Worker (desktop app, separate domain). */
  readonly VITE_API_URL?: string;
}
