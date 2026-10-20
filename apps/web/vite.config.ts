import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  // Workspace packages (e.g. @myrel/i18n) carry their own react as a devDependency; resolve every
  // react import from this app so the bundle holds exactly one copy (two copies break hooks).
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    // `pnpm dev` runs wrangler dev on :8787 alongside Vite.
    proxy: { "/api": { target: "http://localhost:8787", ws: true } },
  },
});
