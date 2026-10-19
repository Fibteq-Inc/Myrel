import { QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@altair/i18n/react";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "./lib/api";
import { initialLocale, saveLocale } from "./lib/i18n";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

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
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
