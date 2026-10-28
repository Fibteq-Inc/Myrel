import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@myrel/i18n/react";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "./lib/api";
import { reportError } from "./lib/errors";
import { initialLocale, saveLocale } from "./lib/i18n";
import { initTheme } from "./lib/theme";
import { RouteError } from "./components/route-error";
import { ConfirmProvider } from "./components/ui/confirm";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

// A deploy replaced the hashed files this tab still asks for: load the new version, at most once a minute.
window.addEventListener("vite:preloadError", () => {
  const key = "myrel.reloadedForDeploy";
  const last = Number(sessionStorage.getItem(key) ?? 0);
  if (Date.now() - last < 60_000) return;
  sessionStorage.setItem(key, String(Date.now()));
  window.location.reload();
});

initTheme();

const router = createRouter({ routeTree, context: { queryClient }, defaultPreload: "intent", defaultErrorComponent: RouteError });

// Errors nothing caught, under the screen they happened on (its route pattern, not its ids).
const screen = () => router.state.matches.at(-1)?.routeId ?? "?";
window.addEventListener("error", (e) => reportError(e.error ?? e.message, screen()));
window.addEventListener("unhandledrejection", (e) => reportError(e.reason, screen()));

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider initialLocale={initialLocale()} onChange={saveLocale}>
      <QueryClientProvider client={queryClient}>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
