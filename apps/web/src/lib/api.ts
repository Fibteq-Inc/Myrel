import { ApiClient, type Platform, webPlatform } from "@altair/client";
import { QueryClient, queryOptions } from "@tanstack/react-query";

/**
 * API origin. Empty = same origin (the Worker serves the web app). Set
 * VITE_API_URL when the UI runs elsewhere, e.g. inside the desktop app.
 */
const apiUrl = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

// The desktop shell can inject its own platform (keychain, native dialogs) before the app boots.
export const platform: Platform =
  (globalThis as { __ALTAIR_PLATFORM__?: Platform }).__ALTAIR_PLATFORM__ ??
  webPlatform({ crossOrigin: apiUrl !== "" && apiUrl !== globalThis.location?.origin });

export const api = new ApiClient({ baseUrl: apiUrl, tokens: platform.tokens });

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: false } },
});

export const sessionQuery = queryOptions({ queryKey: ["session"], queryFn: () => api.getSession() });
export const projectsQuery = queryOptions({ queryKey: ["projects"], queryFn: () => api.listProjects() });
export const projectQuery = (id: string) =>
  queryOptions({ queryKey: ["projects", id], queryFn: () => api.getProject(id) });
