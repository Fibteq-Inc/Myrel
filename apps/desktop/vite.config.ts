import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const web = (path: string) => fileURLToPath(new URL(`../web/${path}`, import.meta.url));

// The desktop UI is apps/web; this config builds it with the Tauri platform injected first (src/main.ts).
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: web("src/routes"),
      generatedRouteTree: web("src/routeTree.gen.ts"),
    }),
    react(),
    tailwindcss(),
  ],
  clearScreen: false,
  // Tauri expects a fixed port and fails if it is taken.
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // Matches the WebViews Tauri 2 ships on (WebView2, WKWebView on macOS 11+, WebKitGTK 4.1).
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
