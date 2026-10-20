import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@myrel/i18n/react";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "./lib/api";
import { initialLocale, saveLocale } from "./lib/i18n";
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

const router = createRouter({ routeTree, context: { queryClient }, defaultPreload: "intent" });

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
